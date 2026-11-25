import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	checkRateLimit: vi.fn(),
	daily: vi.fn(),
}));

vi.mock("@vercel/firewall", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/meetings/audio-usage", () => ({
	consumeDailyAudioUnits: mocks.daily,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const HOUR_MS = 60 * 60_000;
const SAMPLE_RATE = 16_000;
const CLIP_120S = 120 * SAMPLE_RATE;

const load = async () => {
	vi.resetModules();
	return {
		rateLimit: await import("@/lib/rate-limit"),
		budgets: await import("@/lib/meetings/budgets"),
	};
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
	vi.stubEnv("NODE_ENV", "test");
	mocks.checkRateLimit.mockReset();
	mocks.daily.mockReset();
	mocks.daily.mockResolvedValue({ allowed: true });
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("decideRollingBudget", () => {
	const rule = { limit: 10, windowMs: 60_000 };

	it("allows up to the limit and counts the new cost", async () => {
		const { rateLimit } = await load();
		const slots = new Map([[100, 9]]);
		expect(rateLimit.decideRollingBudget(slots, rule, 1, 100_500)).toEqual({
			allowed: true,
			used: 10,
		});
		expect(
			rateLimit.decideRollingBudget(slots, rule, 2, 100_500),
		).toMatchObject({ allowed: false });
	});

	it("reports when enough of the window frees up", async () => {
		const { rateLimit } = await load();
		const slotMs = rateLimit.rollingBudgetSlotMs(rule);
		expect(slotMs).toBe(1_000);
		const slots = new Map([
			[100, 4],
			[110, 4],
			[120, 2],
		]);
		const now = 125_000;
		expect(rateLimit.decideRollingBudget(slots, rule, 3, now)).toEqual({
			allowed: false,
			retryAfterSeconds: 36,
		});
		expect(rateLimit.decideRollingBudget(slots, rule, 7, now)).toEqual({
			allowed: false,
			retryAfterSeconds: 46,
		});
	});

	it("ignores slots that left the window and never under-counts a partial slot", async () => {
		const { rateLimit } = await load();
		const slots = new Map([
			[39, 10],
			[40, 5],
		]);
		expect(rateLimit.decideRollingBudget(slots, rule, 5, 100_000)).toEqual({
			allowed: true,
			used: 10,
		});
		expect(rateLimit.decideRollingBudget(slots, rule, 5, 100_999)).toEqual({
			allowed: true,
			used: 10,
		});
		expect(rateLimit.decideRollingBudget(slots, rule, 6, 100_999)).toEqual({
			allowed: false,
			retryAfterSeconds: 1,
		});
	});

	it("waits a whole window for a cost larger than the limit", async () => {
		const { rateLimit } = await load();
		expect(rateLimit.decideRollingBudget(new Map(), rule, 11, 0)).toEqual({
			allowed: false,
			retryAfterSeconds: 60,
		});
	});
});

describe("meeting budgets", () => {
	it("uses the documented hourly request limits", async () => {
		const { budgets } = await load();
		expect(budgets.meetingRequestBudget("transcribe")).toEqual({
			limit: 1_200,
			windowMs: HOUR_MS,
		});
		expect(budgets.meetingRequestBudget("notes")).toEqual({
			limit: 60,
			windowMs: HOUR_MS,
		});
		expect(budgets.meetingRequestBudget("ask")).toEqual({
			limit: 120,
			windowMs: HOUR_MS,
		});
		expect(budgets.MEETING_AUDIO_BUDGET).toEqual({
			limit: 5_760,
			windowMs: 24 * HOUR_MS,
		});
	});

	it("limits notes to 60 requests per rolling hour per user", async () => {
		const { budgets } = await load();
		const headers = new Headers();
		for (let index = 0; index < 60; index++) {
			expect(
				await budgets.consumeMeetingRequestBudget("notes", "user-1", headers),
			).toEqual({ limited: false });
			vi.advanceTimersByTime(30_000);
		}
		const limited = await budgets.consumeMeetingRequestBudget(
			"notes",
			"user-1",
			headers,
		);
		expect(limited).toEqual({ limited: true, retryAfterSeconds: 1_860 });
		expect(
			await budgets.consumeMeetingRequestBudget("notes", "user-2", headers),
		).toEqual({ limited: false });
		expect(
			await budgets.consumeMeetingRequestBudget("ask", "user-1", headers),
		).toEqual({ limited: false });

		vi.advanceTimersByTime(1_859_000);
		expect(
			(await budgets.consumeMeetingRequestBudget("notes", "user-1", headers))
				.limited,
		).toBe(true);
		vi.advanceTimersByTime(1_000);
		expect(
			await budgets.consumeMeetingRequestBudget("notes", "user-1", headers),
		).toEqual({ limited: false });
	});

	it("allows 1,200 transcription requests per hour", async () => {
		const { budgets } = await load();
		const headers = new Headers();
		for (let index = 0; index < 1_200; index++) {
			const result = await budgets.consumeMeetingRequestBudget(
				"transcribe",
				"user-1",
				headers,
			);
			if (result.limited) throw new Error(`limited at ${index}`);
		}
		expect(
			(
				await budgets.consumeMeetingRequestBudget(
					"transcribe",
					"user-1",
					headers,
				)
			).limited,
		).toBe(true);
	});

	it("charges one unit per started 10 seconds of audio", async () => {
		const { budgets } = await load();
		const units = (seconds: number) =>
			budgets.meetingAudioUnits(Math.round(seconds * SAMPLE_RATE));
		expect(units(0.1)).toBe(1);
		expect(units(4)).toBe(1);
		expect(units(10)).toBe(1);
		expect(units(10.001)).toBe(2);
		expect(budgets.meetingAudioUnits(10 * SAMPLE_RATE + 1)).toBe(2);
		expect(units(20)).toBe(2);
		expect(units(120)).toBe(12);
		expect(units(0)).toBe(0);
	});

	it("falls back to a rolling day of 5,760 units when the firewall cannot answer", async () => {
		const { budgets } = await load();
		const headers = new Headers();
		for (let index = 0; index < 480; index++) {
			expect(
				await budgets.consumeMeetingAudioBudget("user-1", CLIP_120S, headers),
			).toEqual({ limited: false });
			vi.advanceTimersByTime(60_000);
		}
		const limited = await budgets.consumeMeetingAudioBudget(
			"user-1",
			SAMPLE_RATE,
			headers,
		);
		expect(limited.limited).toBe(true);
		if (limited.limited) {
			expect(limited.daily).toBe(true);
			expect(limited.retryAfterSeconds).toBeGreaterThan(14 * 3_600);
			expect(limited.retryAfterSeconds).toBeLessThanOrEqual(24 * 3_600);
		}
		expect(
			await budgets.consumeMeetingAudioBudget("user-2", CLIP_120S, headers),
		).toEqual({ limited: false });

		vi.advanceTimersByTime(
			limited.limited ? limited.retryAfterSeconds * 1000 : 0,
		);
		expect(
			await budgets.consumeMeetingAudioBudget("user-1", CLIP_120S, headers),
		).toEqual({ limited: false });
		expect(mocks.checkRateLimit).not.toHaveBeenCalled();
	});

	it("issues one firewall check per unit, all in one parallel round trip", async () => {
		vi.stubEnv("NODE_ENV", "production");
		const pending: Array<() => void> = [];
		const allPending = Promise.withResolvers<void>();
		mocks.checkRateLimit.mockImplementation(
			() =>
				new Promise((resolve) => {
					pending.push(() => resolve({ rateLimited: false }));
					if (pending.length === 12) allPending.resolve();
				}),
		);
		const { budgets } = await load();
		const result = budgets.consumeMeetingAudioBudget(
			"user-1",
			CLIP_120S,
			new Headers({ "x-real-ip": "203.0.113.1" }),
		);
		await allPending.promise;
		expect(pending).toHaveLength(12);
		for (const release of pending) release();
		expect(await result).toEqual({ limited: false });
		expect(mocks.checkRateLimit).toHaveBeenCalledTimes(12);
		for (const [ruleId, options] of mocks.checkRateLimit.mock.calls)
			expect([ruleId, options.rateLimitKey]).toEqual([
				"rl_meetings_audio",
				"user-1",
			]);
	});

	it("rejects before the provider when any unit is limited", async () => {
		vi.stubEnv("NODE_ENV", "production");
		let call = 0;
		mocks.checkRateLimit.mockImplementation(async () => {
			call += 1;
			return { rateLimited: call === 7 };
		});
		const { budgets } = await load();
		expect(
			await budgets.consumeMeetingAudioBudget(
				"user-1",
				CLIP_120S,
				new Headers(),
			),
		).toEqual({
			limited: true,
			retryAfterSeconds: budgets.AUDIO_FIREWALL_RETRY_AFTER_SECONDS,
		});
	});

	it("treats a limited unit as final even when another check errors", async () => {
		vi.stubEnv("NODE_ENV", "production");
		mocks.checkRateLimit
			.mockRejectedValueOnce(new Error("firewall unreachable"))
			.mockResolvedValueOnce({ rateLimited: true });
		const { budgets } = await load();
		expect(
			(
				await budgets.consumeMeetingAudioBudget(
					"user-1",
					2 * 10 * SAMPLE_RATE,
					new Headers(),
				)
			).limited,
		).toBe(true);
	});

	it("degrades to the in-memory budget when a firewall check fails", async () => {
		vi.stubEnv("NODE_ENV", "production");
		const { budgets } = await load();
		mocks.checkRateLimit.mockImplementation(async () => {
			if (mocks.checkRateLimit.mock.calls.length % 12 === 3)
				throw new Error("firewall unreachable");
			return { rateLimited: false };
		});
		const headers = new Headers();
		for (let index = 0; index < 480; index++) {
			expect(
				await budgets.consumeMeetingAudioBudget("user-1", CLIP_120S, headers),
			).toEqual({ limited: false });
		}
		const limited = await budgets.consumeMeetingAudioBudget(
			"user-1",
			CLIP_120S,
			headers,
		);
		expect(limited.limited).toBe(true);
		if (limited.limited)
			expect(limited.retryAfterSeconds).not.toBe(
				budgets.AUDIO_FIREWALL_RETRY_AFTER_SECONDS,
			);
	});

	it("degrades to the in-memory budget when the firewall rule is missing", async () => {
		vi.stubEnv("NODE_ENV", "production");
		mocks.checkRateLimit.mockResolvedValue({
			rateLimited: false,
			error: "not-found",
		});
		const { budgets } = await load();
		expect(
			await budgets.consumeMeetingAudioBudget(
				"user-1",
				CLIP_120S,
				new Headers(),
			),
		).toEqual({ limited: false });
		expect(mocks.checkRateLimit).toHaveBeenCalledTimes(12);
	});

	it("keeps the daily cap in the database across instances", async () => {
		vi.stubEnv("NODE_ENV", "production");
		mocks.checkRateLimit.mockResolvedValue({ rateLimited: false });
		mocks.daily.mockResolvedValue({ allowed: false, retryAfterSeconds: 900 });
		const { budgets } = await load();
		expect(
			await budgets.consumeMeetingAudioBudget(
				"user-1",
				CLIP_120S,
				new Headers(),
			),
		).toEqual({ limited: true, retryAfterSeconds: 900, daily: true });
		expect(mocks.daily).toHaveBeenCalledWith("user-1", 12, 5_760);
	});

	it("does not charge the day for a clip the hourly limit refused", async () => {
		vi.stubEnv("NODE_ENV", "production");
		mocks.checkRateLimit.mockResolvedValue({ rateLimited: true });
		const { budgets } = await load();
		expect(
			(
				await budgets.consumeMeetingAudioBudget(
					"user-1",
					CLIP_120S,
					new Headers(),
				)
			).limited,
		).toBe(true);
		expect(mocks.daily).not.toHaveBeenCalled();
	});

	it("falls back to the per-instance day when the database cannot answer", async () => {
		vi.stubEnv("NODE_ENV", "production");
		mocks.checkRateLimit.mockResolvedValue({ rateLimited: false });
		mocks.daily.mockResolvedValue({ allowed: undefined });
		const { budgets } = await load();
		const headers = new Headers();
		for (let index = 0; index < 480; index++)
			expect(
				await budgets.consumeMeetingAudioBudget("user-1", CLIP_120S, headers),
			).toEqual({ limited: false });
		const limited = await budgets.consumeMeetingAudioBudget(
			"user-1",
			CLIP_120S,
			headers,
		);
		expect(limited).toMatchObject({ limited: true, daily: true });
	});

	it("needs no fallback while the firewall and the database both answer", async () => {
		vi.stubEnv("NODE_ENV", "production");
		mocks.checkRateLimit.mockResolvedValue({ rateLimited: false });
		const { budgets } = await load();
		const headers = new Headers();
		for (let index = 0; index < 600; index++)
			expect(
				await budgets.consumeMeetingAudioBudget("user-1", CLIP_120S, headers),
			).toEqual({ limited: false });
	});

	it("charges notes and Ask one more unit per started 100 KB of body", async () => {
		const { budgets } = await load();
		expect(budgets.meetingBodyUnits(0)).toBe(1);
		expect(budgets.meetingBodyUnits(100_000)).toBe(1);
		expect(budgets.meetingBodyUnits(100_001)).toBe(2);
		expect(budgets.meetingBodyUnits(4_000_000)).toBe(40);

		const headers = new Headers();
		expect(
			await budgets.consumeMeetingBodyBudget(
				"notes",
				"user-1",
				90_000,
				headers,
			),
		).toEqual({ limited: false });
		// 20 requests of 250 KB use the whole hour: 1 unit on arrival plus 2.
		for (let index = 0; index < 20; index++) {
			expect(
				(await budgets.consumeMeetingRequestBudget("notes", "user-1", headers))
					.limited,
			).toBe(false);
			expect(
				await budgets.consumeMeetingBodyBudget(
					"notes",
					"user-1",
					250_000,
					headers,
				),
			).toEqual({ limited: false });
		}
		expect(
			(await budgets.consumeMeetingRequestBudget("notes", "user-1", headers))
				.limited,
		).toBe(true);
		expect(
			(
				await budgets.consumeMeetingBodyBudget(
					"ask",
					"user-1",
					250_000,
					headers,
				)
			).limited,
		).toBe(false);
	});

	it("charges body units to the endpoint's firewall rule in one round trip", async () => {
		vi.stubEnv("NODE_ENV", "production");
		mocks.checkRateLimit.mockResolvedValue({ rateLimited: false });
		const { budgets } = await load();
		const headers = new Headers({ "x-real-ip": "203.0.113.1" });
		expect(
			await budgets.consumeMeetingBodyBudget("ask", "user-1", 99_999, headers),
		).toEqual({ limited: false });
		expect(mocks.checkRateLimit).not.toHaveBeenCalled();
		expect(
			await budgets.consumeMeetingBodyBudget("ask", "user-1", 664_000, headers),
		).toEqual({ limited: false });
		expect(mocks.checkRateLimit).toHaveBeenCalledTimes(6);
		for (const [ruleId, options] of mocks.checkRateLimit.mock.calls)
			expect([ruleId, options.rateLimitKey]).toEqual([
				"rl_meetings_ask",
				"user-1",
			]);

		mocks.checkRateLimit.mockResolvedValue({ rateLimited: true });
		expect(
			await budgets.consumeMeetingBodyBudget(
				"notes",
				"user-1",
				300_000,
				headers,
			),
		).toEqual({
			limited: true,
			retryAfterSeconds: budgets.FIREWALL_RETRY_AFTER_SECONDS,
		});
	});

	it("honours a firewall decision in production", async () => {
		vi.stubEnv("NODE_ENV", "production");
		mocks.checkRateLimit.mockResolvedValue({ rateLimited: true });
		const { budgets } = await load();
		expect(
			await budgets.consumeMeetingRequestBudget(
				"ask",
				"user-1",
				new Headers({ "x-real-ip": "203.0.113.1" }),
			),
		).toEqual({
			limited: true,
			retryAfterSeconds: budgets.FIREWALL_RETRY_AFTER_SECONDS,
		});
		expect(mocks.checkRateLimit).toHaveBeenCalledWith(
			"rl_meetings_ask",
			expect.objectContaining({ rateLimitKey: "user-1" }),
		);
	});
});
