import { describe, expect, it, vi } from "vitest";
import {
	buildSlackInstallUrl,
	exchangeSlackOAuthCode,
	SLACK_BOT_SCOPES,
	type SlackUnfurlError,
	sendSlackUnfurl,
} from "@/lib/slack/client";

const config = {
	clientId: "client-id",
	clientSecret: "client-secret",
	signingSecret: "signing-secret",
	redirectUrl: "https://cap.so/api/integrations/slack/callback",
};

const slackResponse = (scope = SLACK_BOT_SCOPES.join(",")) =>
	new Response(
		JSON.stringify({
			ok: true,
			access_token: "xoxb-token",
			scope,
			bot_user_id: "B123",
			team: {
				id: "T123",
				name: "Cap",
			},
			enterprise: null,
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);

describe("Slack API client", () => {
	it("builds an install URL with only the required bot scopes", () => {
		const url = new URL(
			buildSlackInstallUrl({ config, state: "signed-state" }),
		);

		expect(url.origin).toBe("https://slack.com");
		expect(url.pathname).toBe("/oauth/v2/authorize");
		expect(url.searchParams.get("client_id")).toBe("client-id");
		expect(url.searchParams.get("scope")).toBe(SLACK_BOT_SCOPES.join(","));
		expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUrl);
		expect(url.searchParams.get("state")).toBe("signed-state");
	});

	it("accepts a complete OAuth response and preserves the workspace identity", async () => {
		const fetchImpl = vi.fn(async () => slackResponse());
		const result = await exchangeSlackOAuthCode({
			code: "oauth-code",
			config,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(result).toEqual({
			accessToken: "xoxb-token",
			scope: SLACK_BOT_SCOPES.join(","),
			botUserId: "B123",
			teamId: "T123",
			teamName: "Cap",
			enterpriseId: null,
		});
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("rejects OAuth responses that omit a required unfurl scope", async () => {
		const fetchImpl = vi.fn(async () =>
			slackResponse("links:read,links:write"),
		);

		await expect(
			exchangeSlackOAuthCode({
				code: "oauth-code",
				config,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).rejects.toThrow("missing required unfurl scopes");
	});

	it("retries transient unfurl failures with the stable event locator", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
					status: 429,
					headers: {
						"Content-Type": "application/json",
						"Retry-After": "1",
					},
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		const sleepImpl = vi.fn(async () => undefined);

		await sendSlackUnfurl({
			token: "xoxb-token",
			event: {
				channel: "C123",
				messageTs: "123.456",
				unfurlId: "U123",
				source: "conversations_history",
			},
			unfurls: {
				"https://cap.so/s/abc123": {
					blocks: [{ type: "video" }],
				},
			},
			fetchImpl: fetchImpl as unknown as typeof fetch,
			sleepImpl,
		});

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(sleepImpl).toHaveBeenCalledWith(1000);
		const request = fetchImpl.mock.calls[1]?.[1] as RequestInit;
		expect(JSON.parse(String(request.body))).toMatchObject({
			unfurl_id: "U123",
			source: "conversations_history",
		});
	});

	it("marks exhausted transient failures for durable recovery", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ ok: false, error: "server_error" }), {
					status: 503,
					headers: { "Content-Type": "application/json" },
				}),
		);

		await expect(
			sendSlackUnfurl({
				token: "xoxb-token",
				event: {
					channel: "C123",
					messageTs: "123.456",
				},
				unfurls: {
					"https://cap.so/s/abc123": {
						blocks: [{ type: "video" }],
					},
				},
				fetchImpl: fetchImpl as unknown as typeof fetch,
				sleepImpl: vi.fn(async () => undefined),
			}),
		).rejects.toMatchObject({
			name: "SlackUnfurlError",
			retryable: true,
		} satisfies Partial<SlackUnfurlError>);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("marks permanent Slack failures as non-retryable", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		await expect(
			sendSlackUnfurl({
				token: "xoxb-token",
				event: {
					channel: "C123",
					messageTs: "123.456",
				},
				unfurls: {
					"https://cap.so/s/abc123": {
						blocks: [{ type: "video" }],
					},
				},
				fetchImpl: fetchImpl as unknown as typeof fetch,
				sleepImpl: vi.fn(async () => undefined),
			}),
		).rejects.toMatchObject({
			name: "SlackUnfurlError",
			retryable: false,
		} satisfies Partial<SlackUnfurlError>);
		expect(fetchImpl).toHaveBeenCalledOnce();
	});
});
