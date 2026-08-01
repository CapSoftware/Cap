import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	new URL("../../lib/organization-invite-delivery.ts", import.meta.url),
	"utf8",
);

describe("organization invite delivery recovery", () => {
	it("repeats provider delivery with a stable idempotency key", () => {
		expect(source).toContain(
			"idempotencyKey: `organization-invite:$" + "{claimed.id}`",
		);
		expect(source).toContain('emailDeliveryState, "pending"');
		expect(source).toContain("emailDeliveryNextAttemptAt");
		expect(source).toContain('deadLettered ? "dead_letter" : "pending"');
		expect(source).toContain("requeueOrganizationInviteDelivery");
	});

	it("sends outside the claim transaction and fences durable completion", () => {
		const claimTransaction = source.indexOf("await db().transaction");
		const providerSend = source.indexOf("await sendEmail", claimTransaction);
		const completionTransaction = source.indexOf(
			"const eventId = await db().transaction",
			providerSend,
		);
		const sentState = source.indexOf(
			'emailDeliveryState: "sent"',
			completionTransaction,
		);
		const outboxFact = source.indexOf(
			"await persistProductAnalyticsEvent(tx",
			completionTransaction,
		);

		expect(claimTransaction).toBeGreaterThan(-1);
		expect(providerSend).toBeGreaterThan(claimTransaction);
		expect(completionTransaction).toBeGreaterThan(providerSend);
		expect(sentState).toBeGreaterThan(completionTransaction);
		expect(outboxFact).toBeGreaterThan(sentState);
		expect(source).toContain(
			"await attemptProductAnalyticsOutboxDelivery(eventId)",
		);
		expect(source).toContain("isNull(organizations.tombstoneAt)");
		expect(source).toContain("emailDeliveryLeaseOwnerId");
		expect(source).toContain("if (!serverEnv().RESEND_API_KEY)");
		expect(source).toContain('.for("update")');
	});
});
