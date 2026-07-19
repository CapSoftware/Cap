import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Agent } from "@cap/web-domain";

export const agentScopes = [
	"caps:read",
	"caps:comment",
	"caps:write",
	"profile:read",
	"profile:write",
	"caps:upload",
	"caps:process",
	"caps:delete",
	"library:read",
	"library:write",
	"analytics:read",
	"organizations:read",
	"organizations:manage",
	"organizations:members",
	"notifications:read",
	"notifications:write",
	"integrations:read",
	"integrations:write",
	"billing:read",
	"billing:write",
	"developer:read",
	"developer:write",
	"developer:secrets",
] as const satisfies readonly Agent.AgentScope[];

export type AgentAuthorizationRequest = {
	clientId: "cap-cli";
	redirectUri: string;
	state: string;
	codeChallenge: string;
	scopes: Agent.AgentScope[];
};

type AuthorizationParams = Record<string, string | string[] | undefined>;

const single = (value: string | string[] | undefined) =>
	typeof value === "string" ? value : null;

export const isAgentLoopbackRedirectUri = (value: string) => {
	try {
		const url = new URL(value);
		return (
			url.protocol === "http:" &&
			(url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
			url.port.length > 0 &&
			url.pathname === "/callback" &&
			url.username.length === 0 &&
			url.password.length === 0 &&
			url.search.length === 0 &&
			url.hash.length === 0
		);
	} catch {
		return false;
	}
};

export const isAgentState = (value: string) =>
	value.length >= 43 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);

export const isAgentCodeChallenge = (value: string) =>
	value.length === 43 && /^[A-Za-z0-9_-]+$/.test(value);

export const isAgentCodeVerifier = (value: string) =>
	value.length >= 43 && value.length <= 128 && /^[A-Za-z0-9._~-]+$/.test(value);

export const parseAgentScopes = (value: string) => {
	const requested = value.split(" ").filter(Boolean);
	if (
		requested.length === 0 ||
		new Set(requested).size !== requested.length ||
		requested.some(
			(scope) => !agentScopes.includes(scope as Agent.AgentScope),
		) ||
		!requested.includes("caps:read")
	) {
		return null;
	}
	return agentScopes.filter((scope) => requested.includes(scope));
};

export const parseAgentAuthorizationRequest = (
	params: AuthorizationParams,
): AgentAuthorizationRequest | null => {
	const clientId = single(params.client_id);
	const redirectUri = single(params.redirect_uri);
	const responseType = single(params.response_type);
	const state = single(params.state);
	const codeChallenge = single(params.code_challenge);
	const codeChallengeMethod = single(params.code_challenge_method);
	const scope = single(params.scope);
	const scopes = scope ? parseAgentScopes(scope) : null;
	if (
		clientId !== "cap-cli" ||
		!redirectUri ||
		!isAgentLoopbackRedirectUri(redirectUri) ||
		responseType !== "code" ||
		!state ||
		!isAgentState(state) ||
		!codeChallenge ||
		!isAgentCodeChallenge(codeChallenge) ||
		codeChallengeMethod !== "S256" ||
		!scopes
	) {
		return null;
	}
	return { clientId, redirectUri, state, codeChallenge, scopes };
};

export const hashAgentSecret = (value: string) =>
	createHash("sha256").update(value).digest("hex");

export const verifyAgentCodeChallenge = (
	verifier: string,
	challenge: string,
) => {
	if (!isAgentCodeVerifier(verifier) || !isAgentCodeChallenge(challenge)) {
		return false;
	}
	const actual = Buffer.from(
		createHash("sha256").update(verifier).digest("base64url"),
	);
	const expected = Buffer.from(challenge);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const createAgentAuthorizationCode = () =>
	randomBytes(32).toString("base64url");

export const createAgentAccessToken = () =>
	`cap_cli_${randomBytes(32).toString("base64url")}`;

export const buildAgentCallbackUrl = (
	redirectUri: string,
	params: { state: string; code?: string; error?: "access_denied" },
) => {
	if (!isAgentLoopbackRedirectUri(redirectUri) || !isAgentState(params.state)) {
		return null;
	}
	if ((params.code ? 1 : 0) + (params.error ? 1 : 0) !== 1) return null;
	const url = new URL(redirectUri);
	url.searchParams.set("state", params.state);
	if (params.code) url.searchParams.set("code", params.code);
	if (params.error) url.searchParams.set("error", params.error);
	return url.toString();
};
