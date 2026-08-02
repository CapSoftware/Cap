import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	identityRows: [[], [{ id: "user-1" }], [{ id: "org-1" }]] as unknown[][],
	identitySelectIndex: 0,
	vercelEnv: "production",
	storedRow: {
		eventId: "signup:user-1",
		lastErrorCode: null as string | null,
		payloadHash: "a".repeat(32),
		payloadKind: "product_event_row_v1",
		payload: {
			event_id: "signup:user-1",
			event_name: "user_signed_up",
			payload_hash: "a".repeat(32),
			received_at: "2026-07-12T12:00:00.000Z",
			properties: "{}",
			user_id: "user-1",
			organization_id: "org-1",
			synthetic_run_id: "",
		},
	},
	deleteSuppressed: vi.fn(),
	sendProductAnalyticsRows: vi.fn(),
	markDeadLetter: vi.fn(),
	markDelivered: vi.fn(),
	markRetrying: vi.fn(),
	acquireIngestionLease: vi.fn(),
	releaseIngestionLease: vi.fn(),
}));

vi.mock("@/lib/analytics/product-event-outbox-state", () => ({
	acquireProductAnalyticsIngestionLease: mocks.acquireIngestionLease,
	deleteSuppressedProductAnalyticsOutboxRow: mocks.deleteSuppressed,
	markProductAnalyticsOutboxDeadLetter: mocks.markDeadLetter,
	markProductAnalyticsOutboxDelivered: mocks.markDelivered,
	markProductAnalyticsOutboxRetrying: mocks.markRetrying,
	releaseProductAnalyticsIngestionLease: mocks.releaseIngestionLease,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: (selection: Record<string, unknown>) => {
			if ("eventId" in selection) {
				return {
					from: () => ({
						where: () => ({ limit: async () => [mocks.storedRow] }),
					}),
				};
			}
			if ("userId" in selection) {
				return { from: () => ({ where: () => ({}) }) };
			}
			return {
				from: () => ({
					where: () => ({
						limit: async () =>
							mocks.identityRows[mocks.identitySelectIndex++] ?? [],
					}),
				}),
			};
		},
	}),
}));

vi.mock("drizzle-orm", async (importOriginal) => ({
	...(await importOriginal<typeof import("drizzle-orm")>()),
	and: (...conditions: unknown[]) => conditions,
	eq: () => true,
	isNull: () => true,
	notInArray: () => true,
}));

vi.mock("@cap/analytics", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/analytics")>()),
	sendProductAnalyticsRows: mocks.sendProductAnalyticsRows,
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		PRODUCT_ANALYTICS_TINYBIRD_HOST: "https://staging.tinybird.test",
		PRODUCT_ANALYTICS_TINYBIRD_TOKEN: "ingest-token",
		VERCEL_ENV: mocks.vercelEnv,
	}),
}));

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));

vi.mock("workflow/api", () => ({
	start: vi.fn(),
}));

import { deliverProductAnalyticsRowStep } from "@/workflows/product-analytics-delivery-workflow";

const deliveryKey = "00000000-0000-4000-8000-000000000001";

describe("durable product analytics delivery", () => {
	beforeEach(() => {
		mocks.identityRows = [[], [{ id: "user-1" }], [{ id: "org-1" }]];
		mocks.identitySelectIndex = 0;
		mocks.vercelEnv = "production";
		mocks.storedRow = {
			eventId: "signup:user-1",
			lastErrorCode: null,
			payloadHash: "a".repeat(32),
			payloadKind: "product_event_row_v1",
			payload: {
				event_id: "signup:user-1",
				event_name: "user_signed_up",
				payload_hash: "a".repeat(32),
				received_at: "2026-07-12T12:00:00.000Z",
				properties: "{}",
				user_id: "user-1",
				organization_id: "org-1",
				synthetic_run_id: "",
			},
		};
		mocks.deleteSuppressed.mockReset().mockResolvedValue(undefined);
		mocks.sendProductAnalyticsRows.mockReset().mockResolvedValue(undefined);
		mocks.markDeadLetter.mockReset().mockResolvedValue(undefined);
		mocks.markDelivered.mockReset().mockResolvedValue(undefined);
		mocks.markRetrying.mockReset().mockResolvedValue(undefined);
		mocks.acquireIngestionLease
			.mockReset()
			.mockResolvedValue("ingestion-lease-1");
		mocks.releaseIngestionLease.mockReset().mockResolvedValue(undefined);
	});

	it("suppresses a user that is missing or pending account deletion", async () => {
		mocks.identityRows = [[], [], [{ id: "org-1" }]];

		await expect(deliverProductAnalyticsRowStep(deliveryKey)).resolves.toEqual({
			status: "suppressed",
		});
		expect(mocks.sendProductAnalyticsRows).not.toHaveBeenCalled();
		expect(mocks.deleteSuppressed).toHaveBeenCalledWith(
			deliveryKey,
			mocks.storedRow.payloadHash,
		);
	});

	it("suppresses an organization after its tombstone is written", async () => {
		mocks.identityRows = [[], [{ id: "user-1" }], []];

		await expect(deliverProductAnalyticsRowStep(deliveryKey)).resolves.toEqual({
			status: "suppressed",
		});
		expect(mocks.sendProductAnalyticsRows).not.toHaveBeenCalled();
	});

	it("delivers once when both durable identities remain active", async () => {
		await expect(deliverProductAnalyticsRowStep(deliveryKey)).resolves.toEqual({
			status: "delivered",
		});
		expect(mocks.sendProductAnalyticsRows).toHaveBeenCalledTimes(1);
		expect(mocks.sendProductAnalyticsRows).toHaveBeenCalledWith(
			expect.objectContaining({ maxAttempts: 1, wait: true }),
		);
		expect(mocks.markDelivered).toHaveBeenCalledWith(
			deliveryKey,
			mocks.storedRow.payloadHash,
		);
	});

	it("dead-letters a permanent provider rejection", async () => {
		const { ProductAnalyticsError } = await import("@cap/analytics");
		mocks.sendProductAnalyticsRows.mockRejectedValueOnce(
			new ProductAnalyticsError({
				cause: new Error("rejected"),
				retryable: false,
				status: 400,
			}),
		);

		await expect(deliverProductAnalyticsRowStep(deliveryKey)).rejects.toThrow(
			"permanently rejected",
		);
		expect(mocks.markDeadLetter).toHaveBeenCalledWith(
			deliveryKey,
			mocks.storedRow.payloadHash,
			"provider_rejected",
		);
	});

	it("keeps a retryable provider failure observable", async () => {
		mocks.sendProductAnalyticsRows.mockRejectedValueOnce(
			new Error("temporary"),
		);

		await expect(deliverProductAnalyticsRowStep(deliveryKey)).rejects.toThrow(
			"temporarily failed",
		);
		expect(mocks.markRetrying).toHaveBeenCalledWith(
			deliveryKey,
			mocks.storedRow.payloadHash,
		);
	});

	it("retries a preview purchase after a simulated lost acknowledgement", async () => {
		mocks.vercelEnv = "preview";
		mocks.identityRows = [[], []];
		mocks.storedRow = {
			...mocks.storedRow,
			eventId: "stripe:staging_ambiguous_purchase_1:purchase_completed",
			payload: {
				...mocks.storedRow.payload,
				event_id: "stripe:staging_ambiguous_purchase_1:purchase_completed",
				event_name: "purchase_completed",
				synthetic_run_id: "run_staging_server",
			},
		};

		await expect(deliverProductAnalyticsRowStep(deliveryKey)).rejects.toThrow(
			"acknowledgement lost",
		);
		expect(mocks.markRetrying).toHaveBeenCalledWith(
			deliveryKey,
			mocks.storedRow.payloadHash,
			"staging_timeout_after_accept",
		);

		mocks.storedRow.lastErrorCode = "staging_timeout_after_accept";
		await expect(deliverProductAnalyticsRowStep(deliveryKey)).resolves.toEqual({
			status: "delivered",
		});
		expect(mocks.sendProductAnalyticsRows).toHaveBeenCalledTimes(2);
	});

	it.each([
		["429", "staging_provider_429"],
		["503", "staging_provider_503"],
	] as const)(
		"retries a preview provider %s response before delivery",
		async (status, errorCode) => {
			mocks.vercelEnv = "preview";
			mocks.identityRows = [[], []];
			mocks.storedRow = {
				...mocks.storedRow,
				eventId: `staging_retry_${status}_event_1`,
				payload: {
					...mocks.storedRow.payload,
					event_id: `staging_retry_${status}_event_1`,
					synthetic_run_id: "run_staging_server",
				},
			};

			await expect(deliverProductAnalyticsRowStep(deliveryKey)).rejects.toThrow(
				`returned ${status}`,
			);
			expect(mocks.sendProductAnalyticsRows).not.toHaveBeenCalled();
			expect(mocks.markRetrying).toHaveBeenCalledWith(
				deliveryKey,
				mocks.storedRow.payloadHash,
				errorCode,
			);

			mocks.storedRow.lastErrorCode = errorCode;
			await expect(
				deliverProductAnalyticsRowStep(deliveryKey),
			).resolves.toEqual({
				status: "delivered",
			});
			expect(mocks.sendProductAnalyticsRows).toHaveBeenCalledTimes(1);
		},
	);

	it("dead-letters a preview contract rejection without provider delivery", async () => {
		mocks.vercelEnv = "preview";
		mocks.identityRows = [[], []];
		mocks.storedRow = {
			...mocks.storedRow,
			eventId: "staging_reject_400_event_1",
			payload: {
				...mocks.storedRow.payload,
				event_id: "staging_reject_400_event_1",
				synthetic_run_id: "run_staging_server",
			},
		};

		await expect(deliverProductAnalyticsRowStep(deliveryKey)).rejects.toThrow(
			"returned 400",
		);
		expect(mocks.markDeadLetter).toHaveBeenCalledWith(
			deliveryKey,
			mocks.storedRow.payloadHash,
			"provider_rejected",
		);
		expect(mocks.sendProductAnalyticsRows).not.toHaveBeenCalled();
		expect(mocks.acquireIngestionLease).not.toHaveBeenCalled();
	});
});
