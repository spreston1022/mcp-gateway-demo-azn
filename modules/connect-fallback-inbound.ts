import { environment, type ZuploContext, type ZuploRequest } from "@zuplo/runtime";

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
 * It applies only to the client IDs listed in `clientIdsEnv`. Place it before
 * the capability filter and token-exchange policies, and add the connect
 * tool's name to the capability filter's `tools` catalog.
 */
interface ConnectFallbackOptions {
  /** Name of the synthetic tool, e.g. "connect_linear". */
  toolName: string;
  /** Human-readable service name used in messages, e.g. "Linear". */
  serviceName: string;
  /**
   * Environment variable holding a comma-separated list of client IDs (the
   * token's azp claim) that get the fallback. Other clients get the standard
   * MCP connect-required response.
   */
  clientIdsEnv: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: string; name?: string };
}

export default async function connectFallback(
  request: ZuploRequest,
  context: ZuploContext,
  options: ConnectFallbackOptions,
  policyName: string,
) {
  if (request.method !== "POST") return request;
  // Only apps known to lack URL elicitation support get the fallback; every
  // other client keeps the standard behavior.
  const clientIds = (environment[options.clientIdsEnv] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const azp = request.user?.data?.azp;
  if (typeof azp !== "string" || !clientIds.includes(azp)) return request;
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
  const isConnectCall = message.method === "tools/call" && message.params?.name === toolName;
  context.addResponseSendingHook(async (response) => {
    const isJson = response.headers.get("content-type")?.includes("application/json");
    // Clients that cache the tool list (Foundry does, per conversation) may
    // call the connect tool after the user has connected. The upstream doesn't
    // know the tool, so answer it here.
    if (isConnectCall && !(isJson && (await isConnectRequired(response)))) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [
              {
                type: "text",
                text: `${serviceName} is connected. Start a new conversation so the ${serviceName} tools load, then ask again.`,
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (!isJson) return response;
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

async function isConnectRequired(response: Response): Promise<boolean> {
  try {
    const body = await response.clone().json();
    return body?.error?.code === -32042;
  } catch {
    return false;
  }
}
