import { describe, expect, it } from "vitest";
import {
	formatBytes,
	formatCharge,
	formatCredits,
	formatDuration,
	summarizeStorageMonth,
	utcDaysAgoKey,
	utcMonthStart,
} from "@/lib/infra-usage";

const snapshot = (snapshotDate: string, microCreditsCharged: number) => ({
	snapshotDate,
	totalDurationMinutes: 100,
	videoCount: 3,
	microCreditsCharged,
});

describe("summarizeStorageMonth", () => {
	const now = new Date("2026-11-10T15:00:00Z");

	it("sums only the current UTC month", () => {
		const result = summarizeStorageMonth(
			[
				snapshot("2026-11-10", 266),
				snapshot("2026-11-01", 260),
				snapshot("2026-10-31", 9999),
				snapshot("2025-11-05", 9999),
			],
			now,
		);
		expect(result).toEqual({ chargedMicroCredits: 526, billedDays: 2 });
	});

	it("returns zero for no snapshots", () => {
		expect(summarizeStorageMonth([], now)).toEqual({
			chargedMicroCredits: 0,
			billedDays: 0,
		});
	});

	it("uses the UTC month at a local month boundary", () => {
		const result = summarizeStorageMonth(
			[snapshot("2026-12-01", 10), snapshot("2026-11-30", 20)],
			new Date("2026-12-01T00:30:00Z"),
		);
		expect(result).toEqual({ chargedMicroCredits: 10, billedDays: 1 });
	});
});

describe("date helpers", () => {
	it("finds the start of the UTC month", () => {
		expect(utcMonthStart(new Date("2026-11-30T23:59:59Z")).toISOString()).toBe(
			"2026-11-01T00:00:00.000Z",
		);
	});

	it("builds a date key some days back", () => {
		expect(utcDaysAgoKey(new Date("2026-03-02T12:00:00Z"), 2)).toBe(
			"2026-02-28",
		);
	});
});

describe("formatting", () => {
	it("formats balances in dollars", () => {
		expect(formatCredits(0)).toBe("$0.00");
		expect(formatCredits(1_234_567_000)).toBe("$12,345.67");
		expect(formatCredits(1_234_567_800)).toBe("$12,345.67800");
	});

	it("keeps small charges visible", () => {
		expect(formatCharge(266)).toBe("$0.00266");
		expect(formatCharge(60)).toBe("$0.00060");
		expect(formatCharge(-250_000)).toBe("$2.50");
		expect(formatCharge(0)).toBe("$0.00");
	});

	it("never shows a real charge as zero", () => {
		expect(formatCharge(1)).toBe("$0.00001");
		expect(formatCharge(-1)).toBe("$0.00001");
		expect(formatCharge(4)).toBe("$0.00004");
		expect(formatCharge(0.2)).toBe("<$0.00001");
		expect(formatCharge(999)).toBe("$0.00999");
		expect(formatCharge(1000)).toBe("$0.01");
		for (const microCredits of [0.6, 1, 2, 7, 49, 50, 198, 999]) {
			expect(formatCharge(microCredits)).not.toMatch(/^\$0\.0+$/);
		}
	});

	it("formats stored sizes", () => {
		expect(formatBytes(null)).toBeNull();
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2_400_000)).toBe("2.4 MB");
		expect(formatBytes(9_000_000)).toBe("9 MB");
		expect(formatBytes(48_300_000)).toBe("48 MB");
		expect(formatBytes(999_900)).toBe("1 MB");
		expect(formatBytes(1_500_000_000)).toBe("1.5 GB");
	});

	it("formats durations", () => {
		expect(formatDuration(null)).toBeNull();
		expect(formatDuration(65.4)).toBe("1:05");
		expect(formatDuration(3723)).toBe("1:02:03");
	});
});
