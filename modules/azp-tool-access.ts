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
 * Returns the Linear tools the calling app may use, from the Entra `azp`
 * claim: the client ID of the app that requested the user's token (for
 * example, the Foundry agent). The user's own Linear permissions still apply
 * upstream; this caps what each app can do on their behalf.
 *
 * AZP_TOOL_PROFILES maps client IDs to profile names, as JSON:
 * {"<agent-client-id>": "read-only"}. Unknown apps get no tools.
 */
export function allowedTools(request: ZuploRequest, context: ZuploContext): string[] {
  const azp = request.user?.data?.azp;
  let profiles: Record<string, string> = {};
  try {
    profiles = JSON.parse(environment.AZP_TOOL_PROFILES ?? "{}");
  } catch {
    context.log.error("AZP_TOOL_PROFILES is not valid JSON; allowing no tools");
  }
  const profile = typeof azp === "string" ? profiles[azp] : undefined;
  context.log.info({ event: "mcp_azp_tool_access", azp: azp ?? null, profile: profile ?? null });
  return profile ? (PROFILES[profile] ?? []) : [];
}

// Capability filter resolver (accessControl.mode "function").
export default function azpToolAccess(
  request: ZuploRequest,
  context: ZuploContext,
): AllowedCapabilities {
  return { tools: allowedTools(request, context) };
}
