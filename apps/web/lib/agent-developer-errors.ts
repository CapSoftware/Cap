import { Agent } from "@cap/web-domain";
import { agentScopeProfiles } from "@/lib/agent-auth";

export const DEVELOPER_APP_NOT_FOUND_MESSAGE =
	"Developer app not found. Run `cap developers list` to see your apps.";

const notFound = (requestId: string, message: string) =>
	new Agent.AgentNotFoundError({
		message,
		retryable: false,
		retryAfterMs: null,
		requestId,
		code: "NOT_FOUND",
	});

export const developerAppNotFound = (requestId: string) =>
	notFound(requestId, DEVELOPER_APP_NOT_FOUND_MESSAGE);

export const developerResourceNotFound = (
	requestId: string,
	resource: "Video" | "Transcript" | "Domain",
) => notFound(requestId, `${resource} not found in this developer app`);

export function agentScopeProfile(scope: Agent.AgentScope) {
	for (const [profile, scopes] of Object.entries(agentScopeProfiles)) {
		if ((scopes as readonly Agent.AgentScope[]).includes(scope)) return profile;
	}
	return "full";
}

export function agentScopeHint(scope: Agent.AgentScope) {
	const profile = agentScopeProfile(scope);
	return `Run \`cap auth login --profile ${profile}\` and approve it in the browser, or create a CLI API key with the ${profile} profile in Cap under Settings, Account and set it as CAP_AGENT_TOKEN.`;
}

export const missingAgentScope = (requestId: string, scope: Agent.AgentScope) =>
	new Agent.AgentForbiddenError({
		message: `The ${scope} permission is required. ${agentScopeHint(scope)}`,
		retryable: false,
		retryAfterMs: null,
		requestId,
		code: "FORBIDDEN",
		hint: agentScopeHint(scope),
		requiredScopes: [scope],
	});
