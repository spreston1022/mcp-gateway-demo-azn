// Minimal "agent acting on your behalf" for Gateway B.
//
// Signs the user in through Entra ID (authorization code + PKCE) as the Demo
// Agent app, gets an access token for the gateway's API, then calls Gateway B's
// MCP endpoint with it. The token's azp claim is this app's client ID, which
// Gateway B uses to decide which Linear tools the agent may use.
//
// Usage: node scripts/demo-agent.mjs [tools/list | call <tool> '<json args>']
// Reads ENTRA_TENANT_ID, DEMO_AGENT_CLIENT_ID and GATEWAY_B_API_CLIENT_ID from
// .env. Set GATEWAY_URL to target a deployed gateway (default localhost:9000).
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { exec } from "node:child_process";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const tenant = env.ENTRA_TENANT_ID;
const clientId = env.DEMO_AGENT_CLIENT_ID;
const scope = `api://${env.GATEWAY_B_API_CLIENT_ID}/mcp.access offline_access`;
const gateway = process.env.GATEWAY_URL ?? "http://localhost:9000";
const mcpUrl = `${gateway}/mcp-b/linear`;
const redirectUri = "http://localhost:8400";
const tokenFile = process.env.TOKEN_CACHE ?? ".demo-agent-token.json";
const authority = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;

const b64url = (buf) => buf.toString("base64url");

async function tokenRequest(params) {
  const res = await fetch(`${authority}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope, ...params }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token error: ${body.error}: ${body.error_description}`);
  return { ...body, expires_at: Date.now() + body.expires_in * 1000 };
}

async function interactiveLogin() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  const url = `${authority}/authorize?${new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })}`;
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const q = new URL(req.url, redirectUri).searchParams;
      res.end(q.get("code") ? "Signed in. You can close this tab." : "Sign-in failed.");
      server.close();
      if (q.get("state") !== state) return reject(new Error("state mismatch"));
      q.get("code") ? resolve(q.get("code")) : reject(new Error(q.get("error_description") ?? "no code"));
    }).listen(8400);
    console.error(`Opening browser to sign in...\n${url}\n`);
    if (process.env.PRINT_AUTH_URL) console.error(`AUTH_URL ${url}`);
    else exec(`open "${url}"`);
  });
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
}

async function getToken() {
  if (existsSync(tokenFile)) {
    const cached = JSON.parse(readFileSync(tokenFile, "utf8"));
    if (cached.expires_at > Date.now() + 60_000) return cached.access_token;
    if (cached.refresh_token) {
      try {
        const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: cached.refresh_token });
        writeFileSync(tokenFile, JSON.stringify(t), { mode: 0o600 });
        return t.access_token;
      } catch {}
    }
  }
  const t = await interactiveLogin();
  writeFileSync(tokenFile, JSON.stringify(t), { mode: 0o600 });
  return t.access_token;
}

async function mcp(token, sessionId, id, method, params) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: process.env.MCP_ACCEPT ?? "application/json, text/event-stream",
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

const token = await getToken();
const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
console.error(`Token: aud=${claims.aud} azp=${claims.azp} scp=${claims.scp} ver=${claims.ver}`);

const init = await mcp(token, undefined, 1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "zuplo-demo-agent", version: "1.0.0" },
});
if (init.status !== 200 || init.data?.error) {
  console.log(JSON.stringify(init, null, 2));
  process.exit(1);
}
await mcp(token, init.sessionId, undefined, "notifications/initialized");

const [cmd = "tools/list", tool, args = "{}"] = process.argv.slice(2);
const result =
  cmd === "call"
    ? await mcp(token, init.sessionId, 2, "tools/call", { name: tool, arguments: JSON.parse(args) })
    : await mcp(token, init.sessionId, 2, "tools/list", {});
if (cmd !== "call" && result.data?.result?.tools) {
  console.log(`${result.data.result.tools.length} tools visible to this agent:`);
  for (const t of result.data.result.tools) console.log(`  - ${t.name}`);
} else {
  console.log(JSON.stringify(result.data, null, 2));
}
