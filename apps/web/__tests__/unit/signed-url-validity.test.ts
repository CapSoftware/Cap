import { describe, expect, it } from "vitest";
import {
	PLAYBACK_URL_EXPIRES_SECONDS,
	playbackUrlValidity,
	STREAM_URL_MIN_SECONDS,
	STREAM_URL_WINDOW_SECONDS,
	streamUrlValidity,
} from "@/lib/signed-url-validity";

const HOUR = 60 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;
// The longest any response carrying a playback URL may be cached: Cap Infra's
// shared-cache answers and the preview redirect.
const LONGEST_CACHE_SECONDS = 300;

const remainingSeconds = (
	validity: { signingDate?: Date; expiresIn: number },
	now: number,
) =>
	((validity.signingDate?.getTime() ?? now) + validity.expiresIn * 1000 - now) /
	1000;

describe("signed URL validity", () => {
	it("hands players MP4 URLs that last 24 hours", () => {
		expect(PLAYBACK_URL_EXPIRES_SECONDS).toBe(24 * HOUR);
		expect(playbackUrlValidity()).toEqual({ expiresIn: 24 * HOUR });
	});

	it("keeps stream URLs valid for 12 to 18 hours at any moment", () => {
		const windowStart = Date.UTC(2026, 10, 23, 6);
		for (const offset of [0, 1, HOUR * 1000, 6 * HOUR * 1000 - 1]) {
			const now = windowStart + offset;
			const validity = streamUrlValidity(now);
			expect(validity.signingDate.getTime()).toBe(windowStart);
			const remaining = remainingSeconds(validity, now);
			expect(remaining).toBeGreaterThan(STREAM_URL_MIN_SECONDS - 1);
			expect(remaining).toBeLessThanOrEqual(
				STREAM_URL_MIN_SECONDS + STREAM_URL_WINDOW_SECONDS,
			);
		}
	});

	it("gives every request in a window the same signature inputs", () => {
		const windowStart = Date.UTC(2026, 10, 23, 12);
		expect(streamUrlValidity(windowStart)).toEqual(
			streamUrlValidity(windowStart + 6 * HOUR * 1000 - 1),
		);
		expect(
			streamUrlValidity(windowStart + 6 * HOUR * 1000).signingDate.getTime(),
		).toBe(windowStart + 6 * HOUR * 1000);
	});

	it("outlives any cached answer plus clock skew", () => {
		const now = Date.UTC(2026, 10, 23, 17, 59, 59);
		const minimum = Math.min(
			remainingSeconds(playbackUrlValidity(), now),
			remainingSeconds(streamUrlValidity(now), now),
		);
		expect(minimum).toBeGreaterThanOrEqual(
			LONGEST_CACHE_SECONDS + CLOCK_SKEW_SECONDS,
		);
	});
});
