import { describe, expect, it } from "vitest";
import {
	advancePlaybackPosition,
	calculatePlaybackSpeed,
	clamp,
	countWords,
	type TeleprompterPlaybackState,
	teleprompterPlaybackRunning,
	updateTeleprompterPlayback,
} from "./teleprompter-utils";

describe("teleprompter utilities", () => {
	it("counts words in pasted scripts", () => {
		expect(countWords("  One   two\nthree ")).toBe(3);
		expect(countWords(" ")).toBe(0);
	});

	it("clamps a setting to its supported range", () => {
		expect(clamp(5, 10, 20)).toBe(10);
		expect(clamp(25, 10, 20)).toBe(20);
	});

	it("calculates a positive scroll speed from reading duration", () => {
		expect(calculatePlaybackSpeed(600, 300, 150)).toBe(5);
		expect(calculatePlaybackSpeed(-10, 300, 150)).toBe(0);
	});

	it("retains sub-pixel movement across animation frames", () => {
		let position = 0;
		for (let frame = 0; frame < 60; frame += 1) {
			position = advancePlaybackPosition(position, 100, 10, 1 / 60);
		}

		expect(position).toBeCloseTo(10);
	});
});

describe("teleprompter recording controls", () => {
	const initial: TeleprompterPlaybackState = {
		requested: false,
		recordingPaused: false,
	};

	it("holds scrolling while recording is paused and preserves playback intent", () => {
		let state = updateTeleprompterPlayback(initial, "play");
		expect(teleprompterPlaybackRunning(state)).toBe(true);
		state = updateTeleprompterPlayback(state, "recording-paused");
		expect(teleprompterPlaybackRunning(state)).toBe(false);
		expect(state.requested).toBe(true);
		state = updateTeleprompterPlayback(state, "recording-resumed");
		expect(teleprompterPlaybackRunning(state)).toBe(true);
	});

	it("does not start a manually paused script on recording resume", () => {
		let state = updateTeleprompterPlayback(initial, "recording-paused");
		state = updateTeleprompterPlayback(state, "recording-resumed");
		expect(teleprompterPlaybackRunning(state)).toBe(false);
	});

	it("lets manual pause cancel automatic resumption", () => {
		let state = updateTeleprompterPlayback(initial, "play");
		state = updateTeleprompterPlayback(state, "recording-paused");
		state = updateTeleprompterPlayback(state, "pause");
		state = updateTeleprompterPlayback(state, "recording-resumed");
		expect(teleprompterPlaybackRunning(state)).toBe(false);
	});

	it("cannot scroll by pressing Play during recording pause", () => {
		let state = updateTeleprompterPlayback(initial, "recording-paused");
		state = updateTeleprompterPlayback(state, "play");
		expect(teleprompterPlaybackRunning(state)).toBe(false);
	});

	it("clears automatic resumption when recording stops", () => {
		let state = updateTeleprompterPlayback(initial, "play");
		state = updateTeleprompterPlayback(state, "recording-paused");
		state = updateTeleprompterPlayback(state, "recording-stopped");
		state = updateTeleprompterPlayback(state, "recording-resumed");
		expect(teleprompterPlaybackRunning(state)).toBe(false);
	});
});
