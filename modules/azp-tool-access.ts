import {
  environment,
  type ZuploContext,
  type ZuploRequest,
} from "@zuplo/runtime";

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

// Profiles that narrow what a listed app may do. Neither includes delete
// tools. Apps without a profile are not narrowed.
export const PROFILES: Record<string, string[]> = {
  "read-only": READ_TOOLS,
  "read-write": [...READ_TOOLS, "save_issue", "save_comment", "save_document"],
  // Reading issues only, for apps that need less than a read-only user has.
  "issues-read": ["connect_linear", "list_issues", "get_issue", "list_comments", "list_teams"],
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
 * Returns the Linear tools the signed-in user is limited to by their roles, or
 * null when none of their roles is mapped and they aren't narrowed. Roles come
 * from the identity provider (on Gateway A, the Entra app roles in the user's
 * ID token). USER_ROLE_PROFILES maps role to profile, e.g. {"Linear.Read":
 * "read-only"}. A user with several mapped roles gets the union of them.
 */
export function userAllowedTools(request: ZuploRequest, context: ZuploContext): string[] | null {
  const roles = request.user?.data?.roles;
  const userRoles = Array.isArray(roles) ? roles.filter((r): r is string => typeof r === "string") : [];
  let roleProfiles: Record<string, string> = {};
  try {
    roleProfiles = JSON.parse(environment.USER_ROLE_PROFILES ?? "{}");
  } catch {
    context.log.error("USER_ROLE_PROFILES is not valid JSON; no users are narrowed");
  }
  const profiles = userRoles.map((r) => roleProfiles[r]).filter((p): p is string => p !== undefined);
  context.log.info({ event: "mcp_user_tool_access", roles: userRoles, profiles });
  if (profiles.length === 0) return null;
  return [...new Set(profiles.flatMap((p) => PROFILES[p] ?? []))];
}

/**
 * Returns the Linear tools the calling app is limited to, or null when the app
 * has no profile and may use every tool. The user's own Linear permissions
 * still apply upstream. Profile maps are JSON, e.g. {"<client-id>":
 * "read-only"}. A profile name that doesn't exist allows no tools.
 */
export function allowedTools(
  request: ZuploRequest,
  context: ZuploContext,
  source: CallerSource = "azp",
): string[] | null {
  const { claim, env } = SOURCES[source];
  const caller = request.user?.data?.[claim];
  let profiles: Record<string, string> = {};
  try {
    profiles = JSON.parse(environment[env] ?? "{}");
  } catch {
    context.log.error(`${env} is not valid JSON; no apps are narrowed`);
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
  if (profile === undefined) return null;
  return PROFILES[profile] ?? [];
}
