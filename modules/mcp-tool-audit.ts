import type { ZuploContext, ZuploRequest } from "@zuplo/runtime";

interface AuditOptions {
  /** Name of this route, e.g. "gateway-a". */
  gateway: string;
  /** Name of the upstream MCP server, e.g. "linear". */
  mcpServer: string;
}

interface ToolCall {
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: unknown };
}

interface JsonRpcReply {
  id?: string | number | null;
  result?: { isError?: boolean };
  error?: { code?: number; message?: string };
}

const MAX_STRING = 200;
const SECRET_KEY = /token|secret|password|api[-_]?key|authorization/i;

/**
 * Writes one `mcp_tool_audit` log entry per MCP tool call: who called it, from
 * which agent, which tool with which arguments, whether the gateway allowed it,
 * and how it ended.
 *
 * Place it right after the authentication policy, so the caller is known and
 * calls blocked by later tool filters are still logged. The response is read in
 * the background, so logging doesn't delay the client.
 *
 * Approvals clicked in the client (for example Foundry's approval prompt) never
 * reach the gateway, so they aren't logged.
 */
export default async function mcpToolAudit(
  request: ZuploRequest,
  context: ZuploContext,
  options: AuditOptions,
) {
  if (request.method !== "POST") return request;
  let calls: ToolCall[];
  try {
    const body = await request.clone().json();
    calls = (Array.isArray(body) ? body : [body]).filter((m: ToolCall) => m?.method === "tools/call");
  } catch {
    return request;
  }
  if (calls.length === 0) return request;

  const started = Date.now();
  const base = {
    event: "mcp_tool_audit",
    timestamp: new Date(started).toISOString(),
    requestId: context.requestId,
    gateway: options.gateway,
    mcpServer: options.mcpServer,
    user: describeUser(request),
    agent: describeAgent(request),
  };

  context.addResponseSendingHook(async (response) => {
    const copy = response.clone();
    context.waitUntil(
      (async () => {
        const replies = await readReplies(copy);
        for (const call of calls) {
          const reply = replies.find((r) => r.id === call.id) ?? (replies.length === 1 ? replies[0] : undefined);
          context.log.info({
            ...base,
            tool: call.params?.name ?? null,
            arguments: sanitize(call.params?.arguments ?? {}),
            ...decide(response.status, reply),
            durationMs: Date.now() - started,
          });
        }
      })().catch((err) => context.log.error("mcp_tool_audit failed", err)),
    );
    return response;
  });
  return request;
}

function describeUser(request: ZuploRequest) {
  const data = (request.user?.data ?? {}) as Record<string, unknown>;
  return {
    sub: request.user?.sub ?? null,
    name: data.name ?? data.preferred_username ?? null,
    oid: data.oid ?? null,
    roles: Array.isArray(data.roles) ? data.roles : [],
  };
}

function describeAgent(request: ZuploRequest) {
  const data = (request.user?.data ?? {}) as Record<string, unknown>;
  // Gateway A issues its own tokens with the OAuth client ID; Gateway B
  // receives Entra tokens, where azp is the app that requested the token.
  if (typeof data.clientId === "string") {
    const id = data.clientId;
    const kind = id.startsWith("dcr:") ? "dcr" : id.startsWith("https://") ? "cimd" : "other";
    return { id, kind, host: kind === "cimd" ? new URL(id).host : null };
  }
  if (typeof data.azp === "string") return { id: data.azp, kind: "entra-app", host: null };
  return { id: null, kind: "unknown", host: null };
}

/** Decision is the gateway's verdict; outcome is how the call ended. */
function decide(status: number, reply: JsonRpcReply | undefined) {
  const code = reply?.error?.code;
  if (code === -32601) {
    return { decision: "denied", outcome: "blocked", errorCode: code, errorMessage: reply?.error?.message ?? null };
  }
  if (code === -32042) {
    return { decision: "connect_required", outcome: "blocked", errorCode: code, errorMessage: null };
  }
  if (code !== undefined || status >= 400 || !reply) {
    return {
      decision: "allowed",
      outcome: "error",
      errorCode: code ?? status,
      errorMessage: reply?.error?.message ?? null,
    };
  }
  return { decision: "allowed", outcome: reply.result?.isError ? "tool_error" : "success", errorCode: null, errorMessage: null };
}

async function readReplies(response: Response): Promise<JsonRpcReply[]> {
  const text = await response.text();
  const type = response.headers.get("content-type") ?? "";
  const chunks = type.includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5))
    : [text];
  const replies: JsonRpcReply[] = [];
  for (const chunk of chunks) {
    try {
      const parsed = JSON.parse(chunk);
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
        if (m && ("result" in m || "error" in m)) replies.push(m);
      }
    } catch {
      // Not JSON; ignore.
    }
  }
  return replies;
}

/** Truncates long strings and redacts values under secret-looking keys. */
function sanitize(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]));
  }
  return value;
}
