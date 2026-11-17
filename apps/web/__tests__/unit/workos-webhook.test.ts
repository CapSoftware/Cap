import { WorkOS } from "@workos-inc/node";
import { describe, expect, it } from "vitest";
import { verifyWorkosSignature } from "@/lib/sso/workos-webhook";

const secret = "whsec_fixture";
const event = {
	id: "event_01",
	event: "dsync.user.created",
	data: { id: "directory_user_01", organization_id: "org_01", name: "Zoë" },
	created_at: "2026-11-06T12:00:00.000Z",
};

async function sign(payload: unknown, timestamp: number) {
	const signature = await new WorkOS(
		"sk_test_fixture",
	).webhooks.computeSignature(timestamp, payload, secret);
	return `t=${timestamp}, v1=${signature}`;
}

describe("verifyWorkosSignature", () => {
	it("accepts a signature produced by the WorkOS SDK for the raw body", async () => {
		const now = Date.now();
		const header = await sign(event, now);
		expect(
			verifyWorkosSignature(JSON.stringify(event), header, secret, now),
		).toBe(true);
	});

	it("rejects a tampered body, wrong secret, stale timestamp, or malformed header", async () => {
		const now = Date.now();
		const header = await sign(event, now);
		const body = JSON.stringify(event);
		expect(
			verifyWorkosSignature(
				body.replace("org_01", "org_02"),
				header,
				secret,
				now,
			),
		).toBe(false);
		expect(verifyWorkosSignature(body, header, "whsec_other", now)).toBe(false);
		expect(verifyWorkosSignature(body, header, secret, now + 6 * 60_000)).toBe(
			false,
		);
		expect(verifyWorkosSignature(body, null, secret, now)).toBe(false);
		expect(verifyWorkosSignature(body, "v1=abc", secret, now)).toBe(false);
		expect(verifyWorkosSignature(body, `t=${now}`, secret, now)).toBe(false);
	});
});
