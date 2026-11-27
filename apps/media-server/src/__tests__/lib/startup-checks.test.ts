import { describe, expect, test } from "bun:test";
import { getWebhookSecretProblem } from "../../lib/startup-checks";

describe("getWebhookSecretProblem", () => {
	test("rejects a missing secret", () => {
		expect(getWebhookSecretProblem({})).toContain("not set");
	});

	test("rejects the old docker-compose placeholder", () => {
		expect(
			getWebhookSecretProblem({
				MEDIA_SERVER_WEBHOOK_SECRET:
					"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
			}),
		).toContain("placeholder");
	});

	test("allows a placeholder only with the explicit local override", () => {
		expect(
			getWebhookSecretProblem({
				MEDIA_SERVER_WEBHOOK_SECRET: "local-media-server-secret",
				MEDIA_SERVER_ALLOW_INSECURE_SECRET: "true",
			}),
		).toBeNull();
	});

	test("accepts a unique secret", () => {
		expect(
			getWebhookSecretProblem({
				MEDIA_SERVER_WEBHOOK_SECRET: "4b1f0c9e7a2d43e8b6c5f1a09d8e7c6b",
			}),
		).toBeNull();
	});
});
