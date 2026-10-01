# Linear MCP through Zuplo: two gateway patterns

Live gateway: `https://mcp-gateway-demo-azn-main-95fac44.zuplo.app`
(Zuplo account `demos`, project `mcp-gateway-demo-azn`, deploys from `main`).

Both routes proxy Linear's remote MCP server (`https://mcp.linear.app/mcp`) and
store each user's Linear token in the gateway vault, keyed by the user's
subject. Entra issues a different `sub` per application, and the two gateways
use different Entra apps, so a user connects Linear separately for each
gateway.

| | Gateway A: `/mcp-a/linear` | Gateway B: `/mcp-b/linear` |
|---|---|---|
| Client registration | Dynamic Client Registration (DCR) or CIMD with the gateway | Pre-registered app in Entra ID |
| Token the client sends | Gateway-issued, opaque | Entra ID v2 access token |
| Browser login | Gateway delegates to Entra | Entra directly |
| Tool limits per calling app | Yes, by the OAuth `client_id`: per app for CIMD clients, one shared profile for all DCR clients | Yes, by the token's `azp` claim |
| Inbound policy | `mcp-entra-oauth-inbound` | `open-id-jwt-auth-inbound` |

## Agents act with narrower permissions than the user

Everything is allowed by default. Apps listed in a profile map are narrowed
to that profile's tools; every other app gets all the tools the user has.
On Gateway B, `gateway-b-azp-tool-filter` (`modules/caller-tool-filter.ts`)
keys on the token's `azp` claim, mapped in `AZP_TOOL_PROFILES`.

| Caller | Linear tools |
|---|---|
| The user (Linear directly, or Gateway A) | Everything their Linear role allows, 81 tools including deletes |
| Foundry agent (`azp` `772f3f72-…`) | 15 read-only tools |
| Demo Agent (`azp` `e9bba71e-…`) | 15 read-only tools ("read-write" profile available: adds `save_issue`, `save_comment`, `save_document`, never deletes) |
| Any other app | Everything the user has (not narrowed) |

For a narrowed app, hidden tools are removed from `tools/list`, and calling
one returns JSON-RPC `-32601` before the request reaches Linear. The upstream
Linear token keeps the user's full rights, so agents must reach Linear only
through the gateway.

This is a custom policy rather than Zuplo's MCP Capability Filter. That
policy only narrows a fixed tool catalog (with no catalog it doesn't filter at
all), so it can't express allow-by-default, and it only rewrites JSON
responses while Linear answers `tools/list` with SSE.

## Per-app limits on Gateway A with CIMD

Gateway A issues its own tokens, so there is no Entra `azp`. Instead
`gateway-a-client-tool-filter` keys on `request.user.data.clientId`, mapped in
`CLIENT_TOOL_PROFILES`.

- CIMD clients use an HTTPS URL to their metadata document as `client_id`. The
  URL is the same for every user and install, so it identifies the app. The
  demo document is `demo-agent.json` on the `gh-pages` branch, served at
  `https://spreston1022.github.io/mcp-gateway-demo-azn/demo-agent.json`.
  Gateway A can't fetch CIMD documents hosted on any `zuplo.app` hostname
  (tested with its own host and a preview environment), so the document
  lives outside Zuplo.
- DCR clients get a random `dcr:…` ID per registration, so they can't be told
  apart. They all share the `dcr:*` profile.

## Limits by user and app together on Gateway A

Gateway A uses two of Zuplo's MCP Capability Filter policies in a row, so a
tool must pass both:

1. `gateway-a-user-role-filter` (`rolesAndGroups` mode) checks the user's
   Entra app roles from the `roles` claim. Each of Linear's 81 tools is tagged
   with roles: read tools `Linear.Read`, `Linear.Write`, `Linear.Admin`; the
   three save tools `Linear.Write`, `Linear.Admin`; everything else
   `Linear.Admin`. A user with no role gets no tools.
2. `gateway-a-client-tool-filter` (`function` mode) maps the app's `clientId`
   to a profile from `CLIENT_TOOL_PROFILES` (resolver `clientIdToolAccess` in
   `modules/azp-tool-access.ts`). Apps without a profile keep all 81.

The filters only rewrite JSON, and Linear answers `tools/list` with SSE, so the
outbound policy `gateway-a-sse-to-json` converts single-message SSE responses
to JSON first. Blocked calls return `-32601 Method not found`.

| App (profile) | User with `Linear.Read` | User with `Linear.Write` |
|---|---|---|
| claude.ai (`issues-read`) | 4 | 4 |
| Demo Agent via CIMD (`read-write`) | 15, writes blocked (tested in prod) | 18 |
| Any DCR client (`dcr:*`, `read-only`) | 15 (tested in prod) | 15 |
| Unlisted client | 15 | 18 |

claude.ai's `client_id` is `https://claude.ai/oauth/mcp-oauth-client-metadata`.
Logs show `mcp_caller_tool_access` (caller, profile).

Roles reach the gateway when it creates its browser session (cookie
`zuplo_mcp_session`) from the Entra ID token. A role change takes effect only
after that session is recreated: clear the gateway site's cookies, or wait
for the session to expire. Group-based role assignment needs Entra ID P1;
assigning individual users works on the free tier.

Demo: `CIMD_CLIENT_ID=<metadata URL> node scripts/dcr-client.mjs tools/list`
versus the same command without `CIMD_CLIENT_ID`.

After changing a variable, an empty-commit deploy kept the old value here;
a commit with real changes picked it up. When no profile matches, the
`mcp_caller_tool_access` log lists `configuredCallers`.

## Tool call audit log

Both routes run `gateway-{a,b}-tool-audit` (`modules/mcp-tool-audit.ts`) right
after authentication. It writes one `mcp_tool_audit` log entry per
`tools/call`, including calls the tool filters block:

| Field | Contents |
|---|---|
| `timestamp`, `requestId`, `durationMs` | When, which request, how long |
| `gateway`, `mcpServer` | `gateway-a` or `gateway-b`, `linear` |
| `user` | `sub`, `roles` (Gateway A); also `name`, `oid` from the Entra token (Gateway B) |
| `agent` | `id` (CIMD URL, `dcr:…`, or Entra `azp`), `kind`, `host` |
| `tool`, `arguments` | Strings cut at 200 characters, secret-looking keys redacted |
| `decision` | `allowed`, `denied`, `connect_required` |
| `outcome` | `success`, `tool_error`, `blocked`, `error`, with `errorCode` |

Approvals happen inside the client (for example Foundry's approval prompt) and
never reach the gateway, so they aren't logged. The response is read in the
background with `context.waitUntil`, so logging adds no latency.

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
  registers with DCR (or uses CIMD when `CIMD_CLIENT_ID` is set), signs in,
  and calls it.

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
