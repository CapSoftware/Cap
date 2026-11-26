import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	WEBHOOK_MAX_ATTEMPTS,
	WEBHOOK_RETRY_DELAYS_SECONDS,
	webhookRetryDelaySeconds,
} from "@/lib/developer-webhook-events";
import {
	createWebhookSecret,
	developerVideoEventId,
	signWebhookBody,
	verifyWebhookSignature,
} from "@/lib/developer-webhook-signature";

const secret = "cws_0123456789abcdefghjkmnpqrstvwx";
const body = JSON.stringify({ id: "evt_1", type: "video.ready" });
const at = 1_794_500_000;

describe("webhook signature", () => {
	it("signs the timestamp and the raw body with the endpoint secret", () => {
		const expected = createHmac("sha256", secret)
			.update(`${at}.${body}`)
			.digest("hex");
		expect(signWebhookBody(secret, body, at)).toBe(`t=${at},v1=${expected}`);
	});

	it("accepts its own signature inside the five minute window", () => {
		const header = signWebhookBody(secret, body, at);
		for (const drift of [0, 299, -299]) {
			expect(
				verifyWebhookSignature({
					secret,
					body,
					header,
					now: (at + drift) * 1000,
				}),
			).toBe(true);
		}
	});

	it("rejects a timestamp older than five minutes", () => {
		const header = signWebhookBody(secret, body, at);
		expect(
			verifyWebhookSignature({ secret, body, header, now: (at + 301) * 1000 }),
		).toBe(false);
	});

	it("rejects a changed body, another secret and a moved timestamp", () => {
		const header = signWebhookBody(secret, body, at);
		const now = at * 1000;
		expect(
			verifyWebhookSignature({ secret, body: `${body} `, header, now }),
		).toBe(false);
		expect(
			verifyWebhookSignature({ secret: `${secret}x`, body, header, now }),
		).toBe(false);
		expect(
			verifyWebhookSignature({
				secret,
				body,
				header: header.replace(`t=${at}`, `t=${at + 1}`),
				now,
			}),
		).toBe(false);
	});

	it.each([
		null,
		"",
		"v1=abc",
		`t=${at}`,
		`t=${at},v1=zz`,
		`t=soon,v1=${"a".repeat(64)}`,
	])("rejects the malformed header %j", (header) => {
		expect(
			verifyWebhookSignature({ secret, body, header, now: at * 1000 }),
		).toBe(false);
	});

	it("makes secrets with a clear prefix and enough randomness", () => {
		const first = createWebhookSecret();
		expect(first).toMatch(/^cws_[0-9a-z]{30}$/);
		expect(createWebhookSecret()).not.toBe(first);
	});
});

describe("webhook event ids", () => {
	it("names the same event for the same video and type every time", () => {
		const id = developerVideoEventId("video-1", "video.ready");
		expect(id).toMatch(/^evt_[0-9a-f]{24}$/);
		expect(developerVideoEventId("video-1", "video.ready")).toBe(id);
	});

	it("names a different event for another type or another video", () => {
		const id = developerVideoEventId("video-1", "video.ready");
		expect(developerVideoEventId("video-1", "video.errored")).not.toBe(id);
		expect(developerVideoEventId("video-2", "video.ready")).not.toBe(id);
	});
});

describe("webhook retry schedule", () => {
	it("makes eight attempts with growing gaps over about a day", () => {
		expect(WEBHOOK_MAX_ATTEMPTS).toBe(8);
		expect([...WEBHOOK_RETRY_DELAYS_SECONDS]).toEqual([
			60, 300, 1_800, 7_200, 18_000, 28_800, 28_800,
		]);
		const total = WEBHOOK_RETRY_DELAYS_SECONDS.reduce((a, b) => a + b, 0);
		expect(total).toBeGreaterThan(22 * 3_600);
		expect(total).toBeLessThan(26 * 3_600);
		for (let i = 1; i < WEBHOOK_RETRY_DELAYS_SECONDS.length; i++) {
			expect(WEBHOOK_RETRY_DELAYS_SECONDS[i]).toBeGreaterThanOrEqual(
				WEBHOOK_RETRY_DELAYS_SECONDS[i - 1] ?? 0,
			);
		}
	});

	it("has a wait after every attempt but the last", () => {
		expect(webhookRetryDelaySeconds(1)).toBe(60);
		expect(webhookRetryDelaySeconds(7)).toBe(28_800);
		expect(webhookRetryDelaySeconds(8)).toBeNull();
	});
});
