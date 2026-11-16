import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	batches: [] as number[],
	cutoffs: [] as Date[],
	limits: [] as number[],
}));

vi.mock("drizzle-orm", () => ({
	lt: (_column: unknown, value: Date) => value,
}));

vi.mock("@cap/database/schema", () => ({
	appStoreEvents: { createdAt: "createdAt" },
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		delete: () => ({
			where: (cutoff: Date) => {
				mocks.cutoffs.push(cutoff);
				return {
					limit: async (limit: number) => {
						mocks.limits.push(limit);
						return [{ affectedRows: mocks.batches.shift() ?? 0 }];
					},
				};
			},
		}),
	}),
}));

import {
	APP_STORE_EVENT_RETENTION_MS,
	cleanupAppStoreEvents,
} from "@/lib/app-store/cleanup";

describe("cleanupAppStoreEvents", () => {
	beforeEach(() => {
		mocks.batches = [];
		mocks.cutoffs = [];
		mocks.limits = [];
	});

	it("deletes rows older than the retention window in batches until one is short", async () => {
		mocks.batches = [2, 2, 1, 2];
		const now = new Date("2026-11-16T00:00:00Z");

		const deleted = await cleanupAppStoreEvents({ now, batchSize: 2 });

		expect(deleted).toBe(5);
		expect(mocks.limits).toEqual([2, 2, 2]);
		expect(mocks.cutoffs[0]?.getTime()).toBe(
			now.getTime() - APP_STORE_EVENT_RETENTION_MS,
		);
	});

	it("stops after the batch budget", async () => {
		mocks.batches = [3, 3, 3, 3];

		const deleted = await cleanupAppStoreEvents({
			batchSize: 3,
			maxBatches: 2,
		});

		expect(deleted).toBe(6);
		expect(mocks.limits).toHaveLength(2);
	});

	it("keeps a month of rows, longer than cap.ready can fire", () => {
		expect(APP_STORE_EVENT_RETENTION_MS).toBeGreaterThan(
			7 * 24 * 60 * 60 * 1000,
		);
	});
});
