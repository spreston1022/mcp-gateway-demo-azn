// Minimal MCP client for Gateway A: discovers the gateway's authorization
// server, registers itself with Dynamic Client Registration, signs the user in
// (authorization code + PKCE, with the gateway delegating login to Entra), and
// calls the Linear MCP route with the gateway-issued token.
//
// Usage: GATEWAY_URL=https://... node scripts/dcr-client.mjs [tools/list | call <tool> '<json>']
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { exec } from "node:child_process";

const gateway = process.env.GATEWAY_URL ?? "http://localhost:9000";
const mcpUrl = `${gateway}/mcp-a/linear`;
const redirectUri = "http://localhost:8401/callback";
const b64url = (b) => b.toString("base64url");
const getJson = async (url, init) => {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
};

// 1. Discovery (RFC 9728, then RFC 8414)
const prm = await getJson(`${gateway}/.well-known/oauth-protected-resource/mcp-a/linear`);
const asUrl = prm.authorization_servers[0];
const asPath = new URL(asUrl).pathname.replace(/\/$/, "");
const as = await getJson(`${new URL(asUrl).origin}/.well-known/oauth-authorization-server${asPath}`);
console.error(`Authorization server: ${as.issuer}\nRegistration endpoint: ${as.registration_endpoint}`);

// 2. Dynamic Client Registration (RFC 7591)
const client = await getJson(as.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "Zuplo DCR test client",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }),
});
console.error(`Registered client_id: ${client.client_id}`);

// 3. Authorization code + PKCE
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));
const authUrl = `${as.authorization_endpoint}?${new URLSearchParams({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: redirectUri,
  scope: (prm.scopes_supported ?? []).join(" "),
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource: prm.resource,
})}`;
const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const q = new URL(req.url, redirectUri).searchParams;
    res.end(q.get("code") ? "Signed in to Gateway A. You can close this tab." : `Sign-in failed: ${q.get("error_description") ?? q.get("error")}`);
    server.close();
    if (q.get("state") !== state) return reject(new Error("state mismatch"));
    q.get("code") ? resolve(q.get("code")) : reject(new Error(q.get("error_description") ?? q.get("error") ?? "no code"));
  }).listen(8401);
  console.error("Opening browser to sign in...");
  exec(`open "${authUrl}"`);
});

// 4. Token exchange
const token = await getJson(as.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: prm.resource,
  }),
});
const parts = token.access_token.split(".");
console.error(
  parts.length === 3
    ? `Gateway token (JWT): ${Buffer.from(parts[1], "base64url").toString()}`
    : `Gateway token: opaque (${token.access_token.length} chars), expires in ${token.expires_in}s`,
);

// 5. MCP calls
async function mcp(sessionId, id, method, params) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }),
  });
  const text = await res.text();
  const data = text.startsWith("{")
    ? JSON.parse(text)
    : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).at(-1);
  return { status: res.status, sessionId: res.headers.get("mcp-session-id") ?? sessionId, data };
}
const init = await mcp(undefined, 1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "zuplo-dcr-test", version: "1.0.0" },
});
if (init.data?.error) {
  console.log(JSON.stringify(init.data.error, null, 2));
  process.exit(0);
}
await mcp(init.sessionId, undefined, "notifications/initialized");
const [cmd = "tools/list", tool, args = "{}"] = process.argv.slice(2);
const result =
  cmd === "call"
    ? await mcp(init.sessionId, 2, "tools/call", { name: tool, arguments: JSON.parse(args) })
    : await mcp(init.sessionId, 2, "tools/list", {});
if (cmd !== "call" && result.data?.result?.tools) {
  console.log(`${result.data.result.tools.length} tools visible through Gateway A`);
} else {
  console.log(JSON.stringify(result.data, null, 2).slice(0, 2000));
}
