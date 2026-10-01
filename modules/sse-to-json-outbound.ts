import type { ZuploContext, ZuploRequest } from "@zuplo/runtime";

/**
 * Converts single-message SSE responses from the upstream MCP server into
 * plain JSON responses.
 *
 * Zuplo's MCP Capability Filter only rewrites JSON list responses, and Linear
 * answers `tools/list` with SSE, so without this the filter blocks hidden tools
 * but still lists them. Outbound policies run before the capability filter's
 * response hooks, so the filter sees the converted JSON. Streamable HTTP lets
 * a server answer with either content type, so clients accept the JSON.
 *
 * Responses with more than one message, such as progress notifications before
 * a result, pass through unchanged.
 */
export default async function sseToJson(
  response: Response,
  request: ZuploRequest,
  context: ZuploContext,
) {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return response;
  }
  const text = await response.clone().text();
  const messages = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (messages.length !== 1) return response;
  try {
    JSON.parse(messages[0]);
  } catch {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(messages[0], { status: response.status, statusText: response.statusText, headers });
}
