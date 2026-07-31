import { serverEnv } from "@cap/env";

export const SLACK_BOT_SCOPES = [
	"links:read",
	"links:write",
	"links.embed:write",
] as const;

type SlackConfig = {
	clientId: string;
	clientSecret: string;
	signingSecret: string;
	redirectUrl: string;
};

export type SlackOAuthResult = {
	accessToken: string;
	scope: string;
	botUserId: string | null;
	teamId: string;
	teamName: string;
	enterpriseId: string | null;
};

type SlackApiResponse = {
	ok?: boolean;
	error?: string;
};

export class SlackUnfurlError extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = "SlackUnfurlError";
		this.retryable = retryable;
	}
}

const sleep = (durationMs: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, durationMs));

const parseSlackResponse = async (response: Response) => {
	let value: unknown;
	try {
		value = await response.json();
	} catch {
		throw new Error(`Slack returned an invalid response (${response.status})`);
	}
	if (!value || typeof value !== "object") {
		throw new Error(`Slack returned an invalid response (${response.status})`);
	}
	return value as SlackApiResponse & Record<string, unknown>;
};

export const getSlackConfig = (): SlackConfig | null => {
	const env = serverEnv();
	if (
		!env.SLACK_CLIENT_ID ||
		!env.SLACK_CLIENT_SECRET ||
		!env.SLACK_SIGNING_SECRET
	) {
		return null;
	}

	return {
		clientId: env.SLACK_CLIENT_ID,
		clientSecret: env.SLACK_CLIENT_SECRET,
		signingSecret: env.SLACK_SIGNING_SECRET,
		redirectUrl: new URL(
			"/api/integrations/slack/callback",
			env.WEB_URL,
		).toString(),
	};
};

export const isSlackIntegrationConfigured = () =>
	getSlackConfig() !== null &&
	/^[0-9a-f]{64}$/i.test(serverEnv().DATABASE_ENCRYPTION_KEY ?? "");

export const buildSlackInstallUrl = ({
	config,
	state,
}: {
	config: SlackConfig;
	state: string;
}) => {
	const url = new URL("https://slack.com/oauth/v2/authorize");
	url.searchParams.set("client_id", config.clientId);
	url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
	url.searchParams.set("redirect_uri", config.redirectUrl);
	url.searchParams.set("state", state);
	return url.toString();
};

export const exchangeSlackOAuthCode = async ({
	code,
	config,
	fetchImpl = fetch,
}: {
	code: string;
	config: SlackConfig;
	fetchImpl?: typeof fetch;
}): Promise<SlackOAuthResult> => {
	const response = await fetchImpl("https://slack.com/api/oauth.v2.access", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: config.clientId,
			client_secret: config.clientSecret,
			code,
			redirect_uri: config.redirectUrl,
		}),
		signal: AbortSignal.timeout(10_000),
	});
	const body = await parseSlackResponse(response);
	if (!response.ok || body.ok !== true) {
		throw new Error(
			`Slack OAuth failed: ${typeof body.error === "string" ? body.error : response.status}`,
		);
	}

	const accessToken = body.access_token;
	const grantedScopes =
		typeof body.scope === "string"
			? body.scope
					.split(",")
					.map((scope) => scope.trim())
					.filter(Boolean)
			: [];
	const team = body.team;
	const enterprise = body.enterprise;
	if (
		typeof accessToken !== "string" ||
		!team ||
		typeof team !== "object" ||
		typeof (team as { id?: unknown }).id !== "string" ||
		typeof (team as { name?: unknown }).name !== "string"
	) {
		throw new Error("Slack OAuth response is missing workspace credentials");
	}
	if (!SLACK_BOT_SCOPES.every((scope) => grantedScopes.includes(scope))) {
		throw new Error("Slack OAuth response is missing required unfurl scopes");
	}

	return {
		accessToken,
		scope: grantedScopes.join(","),
		botUserId: typeof body.bot_user_id === "string" ? body.bot_user_id : null,
		teamId: (team as { id: string }).id,
		teamName: (team as { name: string }).name,
		enterpriseId:
			enterprise &&
			typeof enterprise === "object" &&
			typeof (enterprise as { id?: unknown }).id === "string"
				? (enterprise as { id: string }).id
				: null,
	};
};

export const sendSlackUnfurl = async ({
	token,
	event,
	unfurls,
	fetchImpl = fetch,
	sleepImpl = sleep,
}: {
	token: string;
	event: {
		channel: string;
		messageTs: string;
		unfurlId?: string;
		source?: string;
	};
	unfurls: Record<string, { blocks: unknown[] }>;
	fetchImpl?: typeof fetch;
	sleepImpl?: (durationMs: number) => Promise<void>;
}) => {
	const locator =
		event.unfurlId && event.source
			? { unfurl_id: event.unfurlId, source: event.source }
			: { channel: event.channel, ts: event.messageTs };
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const response = await fetchImpl("https://slack.com/api/chat.unfurl", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json; charset=utf-8",
				},
				body: JSON.stringify({
					...locator,
					unfurls,
				}),
				signal: AbortSignal.timeout(10_000),
			});
			const body = await parseSlackResponse(response);
			if (response.ok && body.ok === true) return;

			const retryable = response.status === 429 || response.status >= 500;
			if (!retryable || attempt === 3) {
				throw new SlackUnfurlError(
					`Slack unfurl failed: ${typeof body.error === "string" ? body.error : response.status}`,
					retryable,
				);
			}
			const retryAfterSeconds = Number(response.headers.get("Retry-After"));
			const retryAfterMs =
				Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
					? retryAfterSeconds * 1000
					: attempt * 250;
			await sleepImpl(Math.min(retryAfterMs, 2000));
		} catch (error) {
			if (attempt === 3 || error instanceof SlackUnfurlError) {
				throw error;
			}
			await sleepImpl(attempt * 250);
		}
	}
};
