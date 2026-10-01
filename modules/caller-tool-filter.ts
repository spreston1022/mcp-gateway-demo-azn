import type { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { allowedTools, userAllowedTools, type CallerSource } from "./azp-tool-access";

interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: { name?: string };
}

/**
 * Narrows the Linear tools available to a request by both the user and the
 * calling app: a tool is allowed only if the user's roles and the app's
 * profile both allow it.
 *
 * Users and apps without a profile aren't narrowed, so a request with neither
 * passes through untouched. Otherwise `tools/list` shows only the allowed
 * tools, and calls to any other tool are rejected before they reach Linear.
 *
 * This replaces Zuplo's MCP Capability Filter here because that policy can
 * only narrow a fixed tool catalog: with no catalog it doesn't filter at all,
 * so it can't express "allow everything unless the app has a profile". It
 * also only rewrites JSON responses, and Linear answers with SSE.
 */
export default async function callerToolFilter(
  request: ZuploRequest,
  context: ZuploContext,
  options: { source?: CallerSource } = {},
) {
  if (request.method !== "POST") return request;
  let messages: JsonRpcMessage[];
  try {
    const body = await request.clone().json();
    messages = Array.isArray(body) ? body : [body];
  } catch {
    return request;
  }
  const isToolsList = messages.some((m) => m?.method === "tools/list");
  const calls = messages.filter((m) => m?.method === "tools/call");
  if (!isToolsList && calls.length === 0) return request;

  const appTools = allowedTools(request, context, options.source ?? "azp");
  const userTools = userAllowedTools(request, context);
  if (appTools === null && userTools === null) return request;
  const allowed = new Set(
    appTools === null ? userTools : userTools === null ? appTools : appTools.filter((t) => userTools.includes(t)),
  );

  const blocked = calls.find((m) => !allowed.has(m.params?.name ?? ""));
  if (blocked) {
    context.log.info({ event: "mcp_tool_call_blocked", tool: blocked.params?.name ?? null });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: blocked.id ?? null,
        error: { code: -32601, message: `Tool not available to this user or app: ${blocked.params?.name ?? ""}` },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  if (isToolsList) {
    context.addResponseSendingHook(async (response) => filterToolsList(response, allowed));
  }
  return request;
}

async function filterToolsList(response: Response, allowed: Set<string>): Promise<Response> {
  const type = response.headers.get("content-type") ?? "";
  const filterEvent = (event: { result?: { tools?: { name?: string }[] } }) => {
    if (Array.isArray(event?.result?.tools)) {
      event.result.tools = event.result.tools.filter((t) => allowed.has(t.name ?? ""));
    }
    return event;
  };

  let body: string;
  if (type.includes("text/event-stream")) {
    body = (await response.text())
      .split("\n")
      .map((line) => {
        if (!line.startsWith("data:")) return line;
        try {
          return `data: ${JSON.stringify(filterEvent(JSON.parse(line.slice(5))))}`;
        } catch {
          // Not JSON; pass the line through unchanged.
          return line;
        }
      })
      .join("\n");
  } else if (type.includes("application/json")) {
    try {
      const json = await response.clone().json();
      body = JSON.stringify(Array.isArray(json) ? json.map(filterEvent) : filterEvent(json));
    } catch {
      return response;
    }
  } else {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
