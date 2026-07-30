import { describe, expect, it } from "vitest";
import {
	createSlackSignature,
	verifySlackSignature,
} from "@/lib/slack/signature";

describe("Slack request signatures", () => {
	const signingSecret = "test-signing-secret";
	const timestamp = "1720000000";
	const now = Number(timestamp) * 1000;
	const body = '{"type":"event_callback"}';

	it("accepts a current signature over the exact raw body", () => {
		const signature = createSlackSignature({
			body,
			timestamp,
			signingSecret,
		});
		expect(
			verifySlackSignature({
				body,
				timestamp,
				signature,
				signingSecret,
				now,
			}),
		).toBe(true);
	});

	it("rejects tampering, missing headers, and stale requests", () => {
		const signature = createSlackSignature({
			body,
			timestamp,
			signingSecret,
		});
		expect(
			verifySlackSignature({
				body: `${body} `,
				timestamp,
				signature,
				signingSecret,
				now,
			}),
		).toBe(false);
		expect(
			verifySlackSignature({
				body,
				timestamp: undefined,
				signature,
				signingSecret,
				now,
			}),
		).toBe(false);
		expect(
			verifySlackSignature({
				body,
				timestamp,
				signature,
				signingSecret,
				now: now + 301_000,
			}),
		).toBe(false);
	});
});
