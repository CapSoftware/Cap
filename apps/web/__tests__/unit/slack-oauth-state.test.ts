import { describe, expect, it } from "vitest";
import {
	createSlackOAuthState,
	verifySlackOAuthState,
} from "@/lib/slack/oauth-state";

describe("Slack OAuth state", () => {
	const secret = "client-secret";
	const now = 1720000000000;

	it("round-trips a signed, time-bounded state", () => {
		const state = createSlackOAuthState({
			organizationId: "org123",
			userId: "user123",
			secret,
			now,
			nonce: "nonce123",
		});

		expect(verifySlackOAuthState({ state, secret, now })).toMatchObject({
			v: 1,
			organizationId: "org123",
			userId: "user123",
			issuedAt: 1720000000,
			nonce: "nonce123",
		});
	});

	it("rejects tampering, expiry, and states from the future", () => {
		const state = createSlackOAuthState({
			organizationId: "org123",
			userId: "user123",
			secret,
			now,
			nonce: "nonce123",
		});
		expect(
			verifySlackOAuthState({
				state: `${state}x`,
				secret,
				now,
			}),
		).toBeNull();
		expect(
			verifySlackOAuthState({
				state,
				secret,
				now: now + 601_000,
			}),
		).toBeNull();
		expect(
			verifySlackOAuthState({
				state,
				secret,
				now: now - 61_000,
			}),
		).toBeNull();
	});
});
