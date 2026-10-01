# Linear MCP through Zuplo: two gateway patterns

Live gateway: `https://mcp-gateway-demo-azn-main-95fac44.zuplo.app`
(Zuplo account `demos`, project `mcp-gateway-demo-azn`, deploys from `main`).

Both routes proxy Linear's remote MCP server (`https://mcp.linear.app/mcp`) and
store each user's Linear token in the gateway vault, keyed by the user's Entra
identity. A user who connects Linear through one route is connected on both.

| | Gateway A: `/mcp-a/linear` | Gateway B: `/mcp-b/linear` |
|---|---|---|
| Client registration | Dynamic Client Registration (DCR) or CIMD with the gateway | Pre-registered app in Entra ID |
| Token the client sends | Gateway-issued, opaque | Entra ID v2 access token |
| Browser login | Gateway delegates to Entra | Entra directly |
| Tool limits per calling app | Not possible (no `azp` in gateway tokens) | Yes, by the token's `azp` claim |
| Inbound policy | `mcp-entra-oauth-inbound` | `open-id-jwt-auth-inbound` |

## Agents act with narrower permissions than the user

Gateway B's `gateway-b-azp-tool-filter` (Zuplo's MCP Capability Filter policy,
resolver in `modules/azp-tool-access.ts`) maps each calling app to a tool
profile. `AZP_TOOL_PROFILES` holds the mapping.

| Caller | Linear tools |
|---|---|
| The user (Linear directly, or Gateway A) | Everything their Linear role allows, 81 tools including deletes |
| Foundry agent (`azp` `772f3f72-…`) | 15 read-only tools |
| Demo Agent (`azp` `e9bba71e-…`) | 15 read-only tools ("read-write" profile available: adds `save_issue`, `save_comment`, `save_document`, never deletes) |
| Any other app | No tools |

Hidden tools are removed from `tools/list`, and calling one returns JSON-RPC
`-32601 Method not found` before the request reaches Linear. The upstream
Linear token keeps the user's full rights, so agents must reach Linear only
through the gateway.

`sse-tools-list-filter` exists because the capability filter only rewrites
JSON list responses and Linear always answers `tools/list` with SSE.

## Connecting Linear from clients without URL elicitation

When a user hasn't connected Linear, the token-exchange policy answers MCP
requests with a JSON-RPC `-32042` error carrying a connect link (MCP URL
elicitation). Foundry agents don't support this and stall silently.

`connect-fallback-inbound` rewrites that error, for apps listed in
`CONNECT_FALLBACK_CLIENT_IDS` only, into a normal handshake, a single
`connect_linear` tool, and a tool result containing the link. Other clients
keep the standard response and their native prompt.

Known limitation: Foundry caches the MCP tool list for a long time (over 20
minutes observed, surviving new chats and new agent versions). After
connecting, Foundry keeps offering `connect_linear`; calling it returns
"Linear is connected. Start a new conversation…".

To refresh Foundry's tool list, detach and reattach the tool: in the agent's
Tools section choose the tool's menu, then **Remove**, and **Save**; then open
**Tools → linear-via-zuplo-gateway-b → Use in an agent → linear-assistant**.
This keeps the OAuth connection, so no secret is needed. Tested end to end:
connect link shown in chat, Linear connected, tool reattached, real tools
listed.

## Test scripts

- `node scripts/demo-agent.mjs [tools/list | call <tool> '<json>']`: signs in
  through Entra as the Demo Agent and calls Gateway B.
- `node scripts/dcr-client.mjs [tools/list | call …]`: discovers Gateway A,
  registers with DCR, signs in, and calls it.

Set `GATEWAY_URL` to the live gateway; the default is `http://localhost:9000`.

## Azure and Entra (personal tenant `spreston1022gmail.onmicrosoft.com`)

| App registration | Client ID | Role |
|---|---|---|
| Zuplo MCP Gateway A - Browser Login | `770e3e6c-…` | Gateway A's Entra login (web, secret) |
| Zuplo MCP Gateway B - API | `09f0ae4c-…` | Gateway B token audience, `mcp.access` scope, v2 tokens |
| Zuplo MCP Demo Agent (local test client) | `e9bba71e-…` | Public client for `scripts/demo-agent.mjs` |
| Zuplo MCP Foundry Agent | `772f3f72-…` | Foundry's OAuth identity passthrough client |

Foundry: project `spreston1022-8622` (resource group `rg-spreston1022-2524`),
model `gpt-4.1-mini` (Global Standard, 10K TPM), agent `linear-assistant`
with the `linear-via-zuplo-gateway-b` MCP tool. Budget `mcp-demo-10usd`
emails at $5 and $10. Delete the resource group when the demo is over.
