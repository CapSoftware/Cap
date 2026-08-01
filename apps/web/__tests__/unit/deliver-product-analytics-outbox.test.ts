import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const outboxSource = readFileSync(
	new URL("../../lib/analytics/product-event-outbox.ts", import.meta.url),
	"utf8",
);
const stateSource = readFileSync(
	new URL("../../lib/analytics/product-event-outbox-state.ts", import.meta.url),
	"utf8",
);
const deliverySource = readFileSync(
	new URL(
		"../../workflows/product-analytics-delivery-workflow.ts",
		import.meta.url,
	),
	"utf8",
);
const erasureSource = readFileSync(
	new URL(
		"../../../../packages/web-backend/src/Tinybird/ProductAnalyticsErasureLeaseRepo.ts",
		import.meta.url,
	),
	"utf8",
);
const reconciliationSource = readFileSync(
	new URL("../../workflows/reconcile-product-analytics.ts", import.meta.url),
	"utf8",
);

describe("product analytics outbox lifecycle", () => {
	it("keeps the first payload immutable and exposes a conflicting replay", () => {
		expect(outboxSource).toContain(
			"productAnalyticsOutbox.payloadHash} <> $" + "{row.payload_hash}",
		);
		expect(outboxSource).toContain("'payload_conflict'");
		expect(outboxSource).not.toMatch(
			/set:\s*\{[^}]*payloadHash:\s*row\.payload_hash/s,
		);
	});

	it("requeues only a same-hash dead letter after repair", () => {
		expect(outboxSource).toContain(
			"productAnalyticsOutbox.payloadHash} = $" + "{row.payload_hash}",
		);
		expect(outboxSource).toContain(
			"productAnalyticsOutbox.deadLetteredAt} IS NOT NULL, 'pending'",
		);
	});

	it("cannot overwrite a terminal result when delivery finishes before start returns", () => {
		const workflowStart = outboxSource.indexOf(
			"await start(deliverProductAnalyticsRowWorkflow",
		);
		const postStartStatus = outboxSource.indexOf(
			'eq(productAnalyticsOutbox.status, "pending")',
			workflowStart,
		);
		const leaseFence = outboxSource.indexOf(
			"productAnalyticsOutbox.leaseOwnerId",
			postStartStatus,
		);

		expect(workflowStart).toBeGreaterThan(-1);
		expect(postStartStatus).toBeGreaterThan(workflowStart);
		expect(leaseFence).toBeGreaterThan(postStartStatus);
		expect(stateSource).toContain(
			'inArray(productAnalyticsOutbox.status, ["pending", "workflow_started"])',
		);
	});

	it("keeps identity-bearing payloads out of Workflow history", () => {
		expect(outboxSource).toContain(
			"await start(deliverProductAnalyticsRowWorkflow, [",
		);
		expect(outboxSource).toContain("pending.deliveryKey");
		expect(deliverySource).toContain(
			"deliverProductAnalyticsRowWorkflow(deliveryKey: string)",
		);
		expect(deliverySource).not.toContain(
			"deliverProductAnalyticsRowWorkflow(row: ProductEventRow)",
		);
		expect(reconciliationSource).toContain("return { failed, reconciled }");
		expect(reconciliationSource).toContain(
			"loadProductAnalyticsReconciliationPageStep",
		);
		expect(reconciliationSource).toContain(
			"loadStripeAnalyticsReconciliationPageStep",
		);
		expect(reconciliationSource).not.toContain("return { events: reconciled");
	});

	it("terminalizes permanent outcomes and recovers unconfirmed workflows", () => {
		expect(deliverySource).toContain(
			"markProductAnalyticsOutboxDelivered(deliveryKey, row.payload_hash)",
		);
		expect(deliverySource).toContain(
			"deleteSuppressedProductAnalyticsOutboxRow",
		);
		expect(deliverySource).toContain('"provider_rejected"');
		expect(deliverySource).toContain('"staging_timeout_after_accept"');
		expect(outboxSource).toContain(
			'eq(productAnalyticsOutbox.status, "workflow_started")',
		);
		expect(outboxSource).toContain('lastErrorCode: "delivery_unconfirmed"');
	});

	it("bounds recovery capacity and delivered-row retention", () => {
		expect(outboxSource).toContain("const MAX_DRAIN_BATCH_SIZE = 500");
		expect(outboxSource).toContain("const DRAIN_CONCURRENCY = 10");
		expect(outboxSource).toContain(
			"const DELIVERED_RETENTION_MS = 31 * 24 * 60 * 60 * 1_000",
		);
		expect(outboxSource).toContain("capacityPerDay");
		expect(outboxSource).toContain("oldestPendingAgeSeconds");
		expect(outboxSource).toContain("oldestDeadLetterAgeSeconds");
		expect(outboxSource).toContain("payloadConflict");
		expect(outboxSource).toContain("receiptPayloadConflictAttempts");
		expect(outboxSource).toContain("const CLEANUP_BATCH_SIZE = 1_000");
	});

	it("fences user, organization and anonymous outbox rows during erasure", () => {
		expect(erasureSource).toContain(
			"Db.productAnalyticsOutbox.userId, scope.userId",
		);
		expect(erasureSource).toContain("Db.productAnalyticsOutbox.organizationId");
		expect(erasureSource).toContain("Db.productAnalyticsOutbox.anonymousId");
		expect(erasureSource).toContain("Db.productAnalyticsIdentityState");
		expect(erasureSource).toContain("delete(Db.productAnalyticsOutbox)");
		expect(outboxSource).toContain('.for("update")');
		expect(outboxSource).toContain('status: "suppressed" as const');
	});
});
