import type { ZuploContext, ZuploRequest } from "@zuplo/runtime";

/**
 * Serves the Client ID Metadata Document (CIMD) for the demo agent. With CIMD,
 * a client's client_id is the HTTPS URL of a document like this one, so the
 * ID is the same for every user and install and only its publisher can change
 * it. That makes it usable for per-app authorization on Gateway A.
 *
 * A real app's publisher would host this on their own domain; it's served by
 * the gateway here only to keep the demo self-contained.
 */
export default async function cimdDemoClient(request: ZuploRequest, context: ZuploContext) {
  const url = new URL(request.url);
  url.search = "";
  return new Response(
    JSON.stringify({
      client_id: url.toString(),
      client_name: "Zuplo Demo Agent (CIMD)",
      redirect_uris: ["http://localhost:8402/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    { headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } },
  );
}
