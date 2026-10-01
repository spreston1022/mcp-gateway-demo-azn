import {
  environment,
  type ZuploContext,
  type ZuploRequest,
} from "@zuplo/runtime";
import type { AllowedCapabilities } from "@zuplo/runtime/mcp-gateway";

const READ_TOOLS = [
  // Synthetic tool from connect-fallback-inbound, shown only until the user
  // connects Linear.
  "connect_linear",
  "list_issues",
  "get_issue",
  "list_comments",
  "list_projects",
  "get_project",
  "list_teams",
  "get_team",
  "list_users",
  "get_user",
  "list_issue_statuses",
  "list_issue_labels",
  "list_cycles",
  "list_documents",
  "get_document",
  "search_documentation",
];

// Which Linear tools each kind of calling app may use. No profile includes
// delete tools, so an agent can never do everything the user can. The
// capability filter also clamps these to its `tools` catalog in policies.json.
export const PROFILES: Record<string, string[]> = {
  "read-only": READ_TOOLS,
  "read-write": [...READ_TOOLS, "save_issue", "save_comment", "save_document"],
};

/**
 * Which caller identity a route keys on:
 * - "azp" (Gateway B): the Entra `azp` claim, the app that requested the
 *   user's token. Profiles come from AZP_TOOL_PROFILES.
 * - "clientId" (Gateway A): the gateway-issued token's OAuth client ID. For
 *   CIMD clients that's the publisher's metadata URL, stable across users; for
 *   DCR clients it's random per registration, so all DCR clients share the
 *   "dcr:*" entry. Profiles come from CLIENT_TOOL_PROFILES.
 */
export type CallerSource = "azp" | "clientId";

const SOURCES: Record<CallerSource, { claim: string; env: string }> = {
  azp: { claim: "azp", env: "AZP_TOOL_PROFILES" },
  clientId: { claim: "clientId", env: "CLIENT_TOOL_PROFILES" },
};

/**
 * Returns the Linear tools the calling app may use. The user's own Linear
 * permissions still apply upstream; this caps what each app can do on their
 * behalf. Profile maps are JSON, e.g. {"<client-id>": "read-only"}. Unknown
 * apps get no tools.
 */
export function allowedTools(
  request: ZuploRequest,
  context: ZuploContext,
  source: CallerSource = "azp",
): string[] {
  const { claim, env } = SOURCES[source];
  const caller = request.user?.data?.[claim];
  let profiles: Record<string, string> = {};
  try {
    profiles = JSON.parse(environment[env] ?? "{}");
  } catch {
    context.log.error(`${env} is not valid JSON; allowing no tools`);
  }
  let profile = typeof caller === "string" ? profiles[caller] : undefined;
  if (profile === undefined && typeof caller === "string" && caller.startsWith("dcr:")) {
    profile = profiles["dcr:*"];
  }
  context.log.info({
    event: "mcp_caller_tool_access",
    source,
    caller: caller ?? null,
    profile: profile ?? null,
    // Lists the configured callers when none matched, to spot stale config.
    ...(profile === undefined && { configuredCallers: Object.keys(profiles) }),
  });
  return profile ? (PROFILES[profile] ?? []) : [];
}

// Capability filter resolver for Gateway B (accessControl.mode "function").
export default function azpToolAccess(
  request: ZuploRequest,
  context: ZuploContext,
): AllowedCapabilities {
  return { tools: allowedTools(request, context, "azp") };
}

// Capability filter resolver for Gateway A.
export function clientIdToolAccess(
  request: ZuploRequest,
  context: ZuploContext,
): AllowedCapabilities {
  return { tools: allowedTools(request, context, "clientId") };
}
