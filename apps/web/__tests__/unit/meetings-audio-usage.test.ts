import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	update: vi.fn(),
	insert: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		update: () => ({ set: () => ({ where: mocks.update }) }),
		insert: () => ({ ignore: () => ({ values: mocks.insert }) }),
	}),
}));

const usage = await import("@/lib/meetings/audio-usage");

const NOW = new Date("2026-11-24T18:30:00Z");
const rows = (affectedRows: number) => [{ affectedRows }];

beforeEach(() => {
	mocks.update.mockReset();
	mocks.insert.mockReset();
	mocks.insert.mockResolvedValue(rows(1));
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("daily meeting audio", () => {
	it("counts by UTC day and waits until the next one", () => {
		expect(usage.audioUsageDay(new Date("2026-11-24T23:59:59Z"))).toBe(
			"2026-11-24",
		);
		expect(usage.audioUsageDay(new Date("2026-11-25T00:00:00Z"))).toBe(
			"2026-11-25",
		);
		expect(usage.secondsUntilNextDay(NOW)).toBe(5.5 * 3_600);
		expect(
			usage.secondsUntilNextDay(new Date("2026-11-24T23:59:59.500Z")),
		).toBe(1);
	});

	it("charges an existing day in one statement", async () => {
		mocks.update.mockResolvedValue(rows(1));
		expect(await usage.consumeDailyAudioUnits("u1", 3, 10, NOW)).toEqual({
			allowed: true,
		});
		expect(mocks.update).toHaveBeenCalledTimes(1);
		expect(mocks.insert).not.toHaveBeenCalled();
	});

	it("creates the day's row on its first clip", async () => {
		mocks.update.mockResolvedValueOnce(rows(0)).mockResolvedValueOnce(rows(1));
		expect(await usage.consumeDailyAudioUnits("u1", 3, 10, NOW)).toEqual({
			allowed: true,
		});
		expect(mocks.insert).toHaveBeenCalledWith({
			userId: "u1",
			day: "2026-11-24",
			units: 0,
		});
	});

	it("refuses a clip that would pass the cap", async () => {
		mocks.update.mockResolvedValue(rows(0));
		mocks.insert.mockResolvedValue(rows(0));
		expect(await usage.consumeDailyAudioUnits("u1", 3, 10, NOW)).toEqual({
			allowed: false,
			retryAfterSeconds: 5.5 * 3_600,
		});
		expect(await usage.consumeDailyAudioUnits("u1", 11, 10, NOW)).toEqual({
			allowed: false,
			retryAfterSeconds: 5.5 * 3_600,
		});
	});

	it("reports no answer when the database fails", async () => {
		mocks.update.mockRejectedValue(
			Object.assign(new Error("Table doesn't exist"), { name: "QueryError" }),
		);
		expect(await usage.consumeDailyAudioUnits("u1", 3, 10, NOW)).toEqual({
			allowed: undefined,
		});
	});

	it("does not hold the clip when the database is slow", async () => {
		vi.useFakeTimers();
		mocks.update.mockReturnValue(new Promise(() => {}));
		const decision = usage.consumeDailyAudioUnits("u1", 3, 10, NOW);
		await vi.advanceTimersByTimeAsync(usage.MEETING_AUDIO_USAGE_TIMEOUT_MS);
		expect(await decision).toEqual({ allowed: undefined });
	});
});
