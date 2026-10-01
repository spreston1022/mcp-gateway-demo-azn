import type { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { allowedTools } from "./azp-tool-access";

/**
 * Filters `tools/list` responses that arrive as server-sent events.
 *
 * The built-in capability filter blocks calls to hidden tools, but it only
 * rewrites JSON list responses. Linear's MCP server always answers with SSE,
 * so without this policy an agent would see tools it can't call. Place it
 * after the capability filter; tool calls stay enforced there.
 */
export default async function sseToolsListFilter(
  request: ZuploRequest,
  context: ZuploContext,
) {
  let isToolsList = false;
  try {
    const body = await request.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    isToolsList = messages.some((m) => m?.method === "tools/list");
  } catch {
    return request;
  }
  if (!isToolsList) return request;

  const allowed = new Set(allowedTools(request, context));
  context.addResponseSendingHook(async (response) => {
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      return response;
    }
    const text = await response.text();
    const filtered = text
      .split("\n")
      .map((line) => {
        if (!line.startsWith("data:")) return line;
        try {
          const event = JSON.parse(line.slice(5));
          if (Array.isArray(event?.result?.tools)) {
            event.result.tools = event.result.tools.filter((t: { name?: string }) =>
              allowed.has(t.name ?? ""),
            );
            return `data: ${JSON.stringify(event)}`;
          }
        } catch {
          // Not JSON; pass the line through unchanged.
        }
        return line;
      })
      .join("\n");
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(filtered, { status: response.status, statusText: response.statusText, headers });
  });
  return request;
}
