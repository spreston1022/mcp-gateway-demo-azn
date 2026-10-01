import type { ZuploContext, ZuploRequest } from "@zuplo/runtime";

/**
 * Shows the "connect your account" link to MCP clients that don't support URL
 * elicitation, such as Microsoft Foundry agents.
 *
 * When the user hasn't connected the upstream service yet, the token-exchange
 * policy answers every MCP request with a JSON-RPC -32042 error carrying a
 * connect link. Clients that don't understand that error stall. This policy
 * rewrites it into ordinary MCP responses: a successful handshake, a single
 * `connect_<service>` tool, and a tool result containing the link, so the
 * agent can show it in the chat. Once the user connects, requests pass
 * through untouched and the real tools appear.
 *
 * Place it before the capability filter and token-exchange policies, and add
 * the connect tool's name to the capability filter's `tools` catalog.
 */
interface ConnectFallbackOptions {
  /** Name of the synthetic tool, e.g. "connect_linear". */
  toolName: string;
  /** Human-readable service name used in messages, e.g. "Linear". */
  serviceName: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: string };
}

export default async function connectFallback(
  request: ZuploRequest,
  context: ZuploContext,
  options: ConnectFallbackOptions,
  policyName: string,
) {
  if (request.method !== "POST") return request;
  let message: JsonRpcMessage;
  try {
    const body = await request.clone().json();
    // Batches are rare in practice; leave them to the default behavior.
    if (Array.isArray(body)) return request;
    message = body;
  } catch {
    return request;
  }

  const { toolName, serviceName } = options;
  context.addResponseSendingHook(async (response) => {
    if (!response.headers.get("content-type")?.includes("application/json")) {
      return response;
    }
    let body: { error?: { code?: number; data?: { connectRequired?: { authUrl?: string } } } };
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }
    if (body?.error?.code !== -32042) return response;

    const authUrl = body.error.data?.connectRequired?.authUrl;
    context.log.info({ event: "mcp_connect_fallback", policyName, method: message.method ?? null });

    // Notifications get no JSON-RPC response.
    if (message.id === undefined || message.id === null) {
      return new Response(null, { status: 202 });
    }
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: `${serviceName} via Zuplo MCP Gateway`, version: "1.0.0" },
          instructions: `${serviceName} isn't connected for this user yet. Call ${toolName} to get a link the user must open to connect it.`,
        });
      case "tools/list":
        return reply({
          tools: [
            {
              name: toolName,
              description: `Your ${serviceName} account isn't connected yet. Call this tool to get a link the user must open to connect ${serviceName}, then retry the request.`,
              inputSchema: { type: "object", properties: {} },
            },
          ],
        });
      case "tools/call":
        return reply({
          content: [
            {
              type: "text",
              text: authUrl
                ? `${serviceName} isn't connected for this user. Show the user this link and ask them to open it, approve access, and then ask again:\n\n${authUrl}\n\nThe link expires in 15 minutes.`
                : `${serviceName} isn't connected for this user, and no connect link was available. Ask the user to try again.`,
            },
          ],
          isError: true,
        });
      case "ping":
        return reply({});
      case "prompts/list":
        return reply({ prompts: [] });
      case "resources/list":
        return reply({ resources: [] });
      case "resources/templates/list":
        return reply({ resourceTemplates: [] });
      default:
        return response;
    }
  });
  return request;
}
