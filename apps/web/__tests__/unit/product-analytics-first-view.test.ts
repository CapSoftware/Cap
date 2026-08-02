import { readFileSync } from "node:fs";
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

	it("keeps analytics and reconciliation independent of the notification cutoff", () => {
		const route = readFileSync(
			new URL("../../app/api/analytics/track/route.ts", import.meta.url),
			"utf8",
		);
		const reconciliation = readFileSync(
			new URL(
				"../../workflows/reconcile-product-analytics.ts",
				import.meta.url,
			),
			"utf8",
		);
		const claim = route.indexOf("claimFirstExternalView(");
		const cutoffDecision = route.indexOf(
			"const isNewVideo = videoRecord.createdAt >= ANON_NOTIF_CUTOFF",
		);
		expect(claim).toBeGreaterThan(-1);
		expect(claim).toBeLessThan(cutoffDecision);
		expect(route.indexOf("firstViewReceivedEvent({")).toBeLessThan(
			cutoffDecision,
		);
		expect(reconciliation).toContain("isNotNull(videos.firstExternalViewAt)");
		expect(reconciliation).toContain('sourceType: "database_first_view"');
		expect(reconciliation).not.toContain("ANON_NOTIF_CUTOFF");
	});
});
