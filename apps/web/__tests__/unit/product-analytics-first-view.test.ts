import { beforeEach, describe, expect, it, vi } from "vitest";

const where = vi.fn();
const set = vi.fn(() => ({ where }));
const update = vi.fn(() => ({ set }));

vi.mock("@cap/database", () => ({ db: () => ({ update }) }));
vi.mock("@cap/database/schema", () => ({
	videos: { firstExternalViewAt: "firstExternalViewAt", id: "id" },
}));
vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => conditions),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	isNull: vi.fn((field: unknown) => ({ field, isNull: true })),
}));

describe("first external view claim", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uses database timestamp precision for stable reconciliation payloads", async () => {
		const { firstExternalViewTimestamp } = await import(
			"@/lib/analytics/first-view"
		);
		expect(
			firstExternalViewTimestamp(1_753_000_000_987).getMilliseconds(),
		).toBe(0);
	});

	it("allows only the first conditional update to claim the milestone", async () => {
		where.mockResolvedValueOnce([{ affectedRows: 1 }]);
		where.mockResolvedValueOnce([{ affectedRows: 0 }]);
		const { claimFirstExternalView } = await import(
			"@/lib/analytics/first-view"
		);
		const claimedAt = new Date("2026-07-31T12:00:00.000Z");

		await expect(
			claimFirstExternalView("video-1" as never, claimedAt),
		).resolves.toBe(true);
		await expect(
			claimFirstExternalView("video-1" as never, claimedAt),
		).resolves.toBe(false);
		expect(set).toHaveBeenNthCalledWith(1, {
			firstExternalViewAt: claimedAt,
		});
		expect(set).toHaveBeenNthCalledWith(2, {
			firstExternalViewAt: claimedAt,
		});
	});
});
