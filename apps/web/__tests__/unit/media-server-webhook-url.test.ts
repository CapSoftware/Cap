import { describe, expect, test } from "vitest";
import { createMediaServerWebhookUrl } from "@/lib/media-server-webhook-url";

const input = {
	webUrl: "https://staging.cap.so",
	deploymentEnvironment: "preview",
	deploymentHost: "cap-preview.vercel.app",
	automationBypassSecret: "test-bypass&value",
	searchParams: { retryable: "true" },
};

describe("media processing webhook destination", () => {
	test("returns to the originating preview with both callback parameters", () => {
		const url = new URL(createMediaServerWebhookUrl(input));
		expect(url.origin).toBe("https://cap-preview.vercel.app");
		expect(url.pathname).toBe("/api/webhooks/media-server/progress");
		expect(url.searchParams.get("retryable")).toBe("true");
		expect(url.searchParams.get("x-vercel-protection-bypass")).toBe(
			input.automationBypassSecret,
		);
	});

	test.each(["production", "development", undefined])(
		"preserves the normal callback in %s without forwarding the bypass",
		(deploymentEnvironment) => {
			expect(
				createMediaServerWebhookUrl({ ...input, deploymentEnvironment }),
			).toBe(
				"https://staging.cap.so/api/webhooks/media-server/progress?retryable=true",
			);
		},
	);

	test("honors a custom callback destination without leaking preview credentials", () => {
		expect(
			createMediaServerWebhookUrl({
				...input,
				webhookBaseUrl: "https://callbacks.example.com",
			}),
		).toBe(
			"https://callbacks.example.com/api/webhooks/media-server/progress?retryable=true",
		);
	});

	test("authenticates an explicit destination only when it matches this deployment", () => {
		const url = new URL(
			createMediaServerWebhookUrl({
				...input,
				webhookBaseUrl: "https://cap-preview.vercel.app",
			}),
		);
		expect(url.searchParams.get("x-vercel-protection-bypass")).toBe(
			input.automationBypassSecret,
		);
	});

	test.each([
		"cap-preview.vercel.app.attacker.example",
		"user@cap-preview.vercel.app",
		"cap-preview.vercel.app/path",
		"cap-preview.vercel.app:443",
		undefined,
	])("rejects an invalid preview hostname: %s", (deploymentHost) => {
		expect(createMediaServerWebhookUrl({ ...input, deploymentHost })).toBe(
			"https://staging.cap.so/api/webhooks/media-server/progress?retryable=true",
		);
	});

	test("does not invent a bypass when the project has none", () => {
		const url = new URL(
			createMediaServerWebhookUrl({
				...input,
				automationBypassSecret: undefined,
			}),
		);
		expect(url.origin).toBe("https://cap-preview.vercel.app");
		expect(url.searchParams.has("x-vercel-protection-bypass")).toBe(false);
	});
});
