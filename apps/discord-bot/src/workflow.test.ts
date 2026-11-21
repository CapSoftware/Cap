import { env, fetchMock } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "./index";

declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
}

let token: string;
let keys: { keys: Awaited<ReturnType<typeof exportJWK>>[] };

beforeAll(async () => {
	const { privateKey, publicKey } = await generateKeyPair("RS256", {
		extractable: true,
	});
	keys = {
		keys: [{ ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" }],
	};
	token = await new SignJWT({
		repository: "CapSoftware/Cap",
		repository_owner: "CapSoftware",
		repository_id: "123",
		run_id: "456",
		actor: "release-user",
	})
		.setProtectedHeader({ alg: "RS256", kid: "test-key" })
		.setIssuer("https://token.actions.githubusercontent.com")
		.setAudience("cap-discord-bot")
		.setSubject("repo:CapSoftware/Cap:ref:refs/heads/main")
		.setExpirationTime("1h")
		.sign(privateKey);
});

beforeEach(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	fetchMock
		.get("https://token.actions.githubusercontent.com")
		.intercept({ path: "/.well-known/jwks" })
		.reply(200, keys);
	await env.release_discord_interactions.put(
		"interaction-id",
		JSON.stringify({
			token: "interaction-token",
			channel_id: "channel-id",
			member: { user: { id: "user-id" } },
			data: { name: "release" },
		}),
	);
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
	fetchMock.deactivate();
});

async function notify(type: "release-ready" | "release-done") {
	return worker.fetch(
		new Request("https://example.com/github-workflow", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				type,
				tag: "v1.0.0",
				version: "1.0.0",
				interactionId: "interaction-id",
				releaseUrl: "https://github.com/CapSoftware/Cap/releases/tag/v1.0.0",
				cnReleaseId: "cn-release-id",
			}),
		}),
		{ ...env, DISCORD_BOT_TOKEN: "test-bot-token" },
	);
}

for (const notification of [
	{
		type: "release-ready",
		method: "PATCH",
		path: "/api/v10/webhooks/1334742236096757861/interaction-token/messages/@original",
		success: "Successfully updated message",
	},
	{
		type: "release-done",
		method: "POST",
		path: "/api/v10/channels/channel-id/messages",
		success: "Successfully sent message",
	},
] as const) {
	describe(notification.type, () => {
		it("acknowledges a delivered Discord notification", async () => {
			fetchMock
				.get("https://discord.com")
				.intercept({ method: notification.method, path: notification.path })
				.reply(200, { id: "message-id" });

			const response = await notify(notification.type);

			expect(response.status, await response.clone().text()).toBe(200);
			expect(await response.text()).toBe(notification.success);
		});

		it.each([400, 401, 403, 404, 429, 500, 503])(
			"reports a failed notification when Discord returns %s",
			async (status) => {
				fetchMock
					.get("https://discord.com")
					.intercept({ method: notification.method, path: notification.path })
					.reply(status, { message: "Discord rejected the notification" });

				const response = await notify(notification.type);

				expect(response.status).toBe(502);
				expect(await response.text()).not.toContain("Successfully");
			},
		);
	});
}
