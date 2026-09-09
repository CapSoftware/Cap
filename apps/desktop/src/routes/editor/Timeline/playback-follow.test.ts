import { describe, expect, it } from "vitest";
import { PlaybackFollow } from "./playback-follow";

describe("timeline playback following", () => {
	it("leaves the viewport still until the playhead reaches the follow point", () => {
		const follow = new PlaybackFollow();
		const viewport = { position: 0, zoom: 10 };
		for (const time of [0, 1, 4, 8]) {
			expect(follow.update(viewport, time, 60, time * 1000, false)).toBe(0);
		}
	});

	it("scrolls at playback speed without mistaking its own movement for panning", () => {
		const follow = new PlaybackFollow();
		const viewport = { position: 0, zoom: 10 };
		for (let frame = 0; frame <= 600; frame++) {
			const time = 8 + frame / 60;
			viewport.position = follow.update(viewport, time, 60, time * 1000, false);
			expect(time - viewport.position).toBeCloseTo(8);
		}
	});

	it("reveals offscreen seeks and restarts from the beginning", () => {
		const follow = new PlaybackFollow();
		expect(follow.update({ position: 0, zoom: 10 }, 45, 60, 0, false)).toBe(37);
		follow.reset();
		expect(follow.update({ position: 37, zoom: 10 }, 0, 60, 1, false)).toBe(0);
	});

	it("reveals a backward seek with room before the playhead", () => {
		const follow = new PlaybackFollow();
		expect(follow.update({ position: 30, zoom: 10 }, 20, 60, 0, false)).toBe(
			18,
		);
	});

	it("stops scrolling at the project end without exposing extra empty space", () => {
		const follow = new PlaybackFollow();
		expect(follow.update({ position: 49, zoom: 10 }, 60, 60, 0, false)).toBe(
			50,
		);
	});

	it("does not scroll a project that already fits, including short projects", () => {
		for (const [duration, zoom] of [
			[60, 60],
			[2, 3],
		]) {
			const follow = new PlaybackFollow();
			expect(
				follow.update({ position: 0, zoom }, duration, duration, 0, false),
			).toBe(0);
		}
	});

	it("allows manual panning and resumes after a second", () => {
		const follow = new PlaybackFollow();
		follow.update({ position: 0, zoom: 10 }, 9, 60, 0, false);
		const viewport = { position: 30, zoom: 10 };
		expect(follow.update(viewport, 9.1, 60, 100, false)).toBe(30);
		expect(follow.update(viewport, 10, 60, 1099, false)).toBe(30);
		expect(follow.update(viewport, 10, 60, 1100, false)).toBe(8);
	});

	it("preserves a zoom anchor during the grace period", () => {
		const follow = new PlaybackFollow();
		follow.update({ position: 0, zoom: 10 }, 8, 60, 0, false);
		const viewport = { position: 0, zoom: 5 };
		expect(follow.update(viewport, 8, 60, 1, false)).toBe(0);
		expect(follow.update(viewport, 9, 60, 1001, false)).toBe(5);
	});

	it("holds the viewport for the full drag, even when the pointer stops moving", () => {
		const follow = new PlaybackFollow();
		const viewport = { position: 0, zoom: 10 };
		for (const now of [0, 1000, 2000, 3000]) {
			expect(follow.update(viewport, 20, 60, now, true)).toBe(0);
		}
		expect(follow.update(viewport, 20, 60, 3999, false)).toBe(0);
		expect(follow.update(viewport, 20, 60, 4000, false)).toBe(12);
	});

	it("clears manual suspension for a new playback session", () => {
		const follow = new PlaybackFollow();
		follow.update({ position: 30, zoom: 10 }, 0, 60, 0, true);
		follow.reset();
		expect(follow.update({ position: 30, zoom: 10 }, 0, 60, 1, false)).toBe(0);
	});

	it("ignores unavailable duration and invalid playback geometry", () => {
		for (const [zoom, playhead, duration] of [
			[0, 10, 60],
			[10, 10, 0],
			[10, Number.NaN, 60],
			[Number.POSITIVE_INFINITY, 10, 60],
			[10, 10, Number.NaN],
		]) {
			const follow = new PlaybackFollow();
			expect(
				follow.update({ position: 5, zoom }, playhead, duration, 0, false),
			).toBe(5);
		}
	});
});
