import { describe, expect, it, vi } from "vitest";
import type { FrameData } from "~/utils/socket";
import { createPreparingHandoff } from "./preparing-handoff";
import { createPreparingPlaybackHandoff } from "./preparing-playback-handoff";

function deferred() {
	let resolve!: (value: boolean) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<boolean>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

const position = { playheadSeconds: 10.5, playing: true, buffering: false };
const bounds = { width: 787, height: 462 };
function frame(frameNumber: number): FrameData {
	return {
		width: 1196,
		height: 702,
		renderedFrame: { frameNumber, targetTimeNs: 10_500_000_000n },
	};
}

describe("preparing frame handoff", () => {
	it("freezes the nonzero target and retains playing intent across later progress", () => {
		const handoff = createPreparingHandoff();
		expect(handoff.begin(position, 30)).toEqual({
			frameNumber: 315,
			playback: position,
		});
		position.playheadSeconds = 11;
		expect(handoff.begin(position, 30)?.frameNumber).toBe(315);
		expect(handoff.target()?.playback).toEqual({
			playheadSeconds: 10.5,
			playing: true,
			buffering: false,
		});
		position.playheadSeconds = 10.5;
	});

	it.each([
		{ duration: 120, fps: 30, expected: 3599 },
		{ duration: 120.01, fps: 30, expected: 3600 },
		{ duration: 0.01, fps: 30, expected: 0 },
	])(
		"keeps an end playhead separate from the last valid image at $duration seconds",
		({ duration, fps, expected }) => {
			const handoff = createPreparingHandoff();
			const end = {
				playheadSeconds: duration,
				playing: false,
				buffering: false,
			};
			expect(handoff.begin(end, fps, duration)).toEqual({
				frameNumber: expected,
				playback: end,
			});
			expect(handoff.accept(frame(Math.ceil(duration * fps)), bounds)).toBe(
				false,
			);
			expect(handoff.accept(frame(expected), bounds)).toBe(true);
		},
	);

	it("rejects queued, stale and differently targeted frames even if an earlier frame rendered", () => {
		const handoff = createPreparingHandoff();
		handoff.begin(position, 30);
		expect(handoff.accept({ width: 1196, height: 702 }, bounds)).toBe(false);
		expect(handoff.accept(frame(0), bounds)).toBe(false);
		expect(handoff.accept(frame(314), bounds)).toBe(false);
		expect(handoff.accept(frame(315), bounds)).toBe(true);
		expect(handoff.accept(frame(315), bounds)).toBe(false);
	});

	it("does not remove retained footage before positive actual output bounds exist", () => {
		const handoff = createPreparingHandoff();
		handoff.begin(position, 30);
		for (const invalid of [
			{ width: 0, height: 462 },
			{ width: 787, height: Number.NaN },
			{ width: -1, height: 462 },
		]) {
			expect(handoff.accept(frame(315), invalid)).toBe(false);
		}
		expect(handoff.accept(frame(315), bounds)).toBe(true);
	});

	it("replaces the pending target when an ordinary scrub supersedes initial handoff", () => {
		const handoff = createPreparingHandoff();
		handoff.begin(position, 30, 120);
		expect(handoff.requestFrame(45)).toBe(45);
		expect(handoff.accept(frame(315), bounds)).toBe(false);
		expect(handoff.accept(frame(45), bounds)).toBe(true);
		expect(handoff.target()?.playback.playheadSeconds).toBe(10.5);
		expect(handoff.requestFrame(3600)).toBe(3600);
	});

	it("keeps the first ordinary end request clamped without changing later ordinary behavior", () => {
		const handoff = createPreparingHandoff();
		expect(handoff.requestFrame(3600)).toBe(3600);
		handoff.begin({ ...position, playheadSeconds: 120 }, 30, 120);
		expect(handoff.requestFrame(3600)).toBe(3599);
		expect(handoff.requestedFrame()).toBe(3599);
		expect(handoff.accept(frame(3599), bounds)).toBe(true);
		expect(handoff.requestFrame(3600)).toBe(3600);
	});

	it("accepts a real advancing ordinary frame when playback skips its starting frame", () => {
		const handoff = createPreparingHandoff();
		handoff.begin(position, 30, 120);
		handoff.setAdvancing(true, 315);
		expect(handoff.accept(frame(314), bounds)).toBe(false);
		expect(handoff.accept(frame(3600), bounds)).toBe(false);
		expect(handoff.accept(frame(319), bounds)).toBe(true);
	});

	it("returns to an exact paused frame after playback changes before replacement", () => {
		const handoff = createPreparingHandoff();
		handoff.begin(position, 30, 120);
		handoff.setAdvancing(true, 315);
		handoff.setAdvancing(false, 340);
		expect(handoff.accept(frame(339), bounds)).toBe(false);
		expect(handoff.accept(frame(341), bounds)).toBe(false);
		expect(handoff.accept(frame(340), bounds)).toBe(true);
	});

	it("keeps unknown or unrepresentable targets out of the frame replacement latch", () => {
		const handoff = createPreparingHandoff();
		for (const fps of [0, Number.NaN, Number.POSITIVE_INFINITY])
			expect(handoff.begin(position, fps)).toBeUndefined();
		expect(
			handoff.begin({ ...position, playheadSeconds: 1e15 }, 30),
		).toBeUndefined();
		expect(handoff.accept(frame(0), bounds)).toBe(false);
		expect(
			handoff.begin({ ...position, playheadSeconds: 0 }, 30)?.frameNumber,
		).toBe(0);
	});
	it("uses final recording duration for both actual frame and displayed position", () => {
		const handoff = createPreparingHandoff();
		const target = handoff.begin(
			{ playheadSeconds: 10.05, playing: false, buffering: false },
			60,
			10,
		);
		expect(target?.frameNumber).toBe(599);
		expect(target?.playback.playheadSeconds).toBe(10);
	});
	it("continues exact frame checks for a newer seek while playback start is pending after image handoff", () => {
		const handoff = createPreparingHandoff();
		handoff.begin(position, 30, 120);
		expect(handoff.accept(frame(315), bounds)).toBe(true);
		handoff.requestFrame(60, true);
		expect(handoff.matches(frame(315), bounds)).toBe(false);
		expect(handoff.matches(frame(60), { width: 0, height: 462 })).toBe(false);
		expect(handoff.matches(frame(60), bounds)).toBe(true);
		expect(handoff.accept(frame(60), bounds)).toBe(false);
	});
});

describe("preparing frame approval", () => {
	it("holds a late native commit until an adopted pause receives its next presented frame", async () => {
		const handoff = createPreparingHandoff();
		handoff.begin(position, 30, 120, "first");
		handoff.setAdvancing(true, 315);
		const nativeCommit = deferred();
		const nativePause = deferred();
		const fallbackReady = deferred();
		const start = vi.fn(async () => {});
		const stop = vi.fn(async () => {});
		const stopNativePlayback = vi.fn(async () => {});
		const changed = vi.fn();
		const settled = vi.fn();
		const failed = vi.fn();
		const playback = createPreparingPlaybackHandoff({
			initial: { frameNumber: 315, playing: true },
			start,
			stop,
			changed,
			settled,
			failed,
		});
		const approval = handoff.commitFrame(
			frame(315),
			bounds,
			() => nativeCommit.promise,
		);
		if (!approval) throw new Error("Initial frame did not request approval");
		const oldSettlement = approval.then((accepted) => {
			if (accepted) playback.acknowledge(315, true);
			return accepted;
		});
		const releaseFrames = handoff.holdFrames();
		const pause = nativePause.promise.catch(async (error: unknown) => {
			expect(error).toEqual(new Error("Preparing playback has been adopted"));
			await stopNativePlayback();
			handoff.requestFrame(315, true);
			const pending = playback.request({ frameNumber: 315, playing: false });
			if (!pending) throw new Error("Pause lost its pending playback owner");
			releaseFrames();
			fallbackReady.resolve(true);
			return pending;
		});
		const blockedApproval = vi.fn(async () => true);
		expect(
			handoff.commitFrame(frame(316), bounds, blockedApproval),
		).toBeUndefined();
		expect(blockedApproval).not.toHaveBeenCalled();
		nativeCommit.resolve(true);
		expect(await oldSettlement).toBe(false);
		expect(playback.active()).toBe(true);
		expect(start).not.toHaveBeenCalled();
		expect(settled).not.toHaveBeenCalled();
		nativePause.reject(new Error("Preparing playback has been adopted"));
		expect(await fallbackReady.promise).toBe(true);
		expect(playback.intent()).toEqual({ frameNumber: 315, playing: false });
		expect(settled).not.toHaveBeenCalled();
		expect(
			await handoff.commitFrame(frame(315), bounds, async () => true),
		).toBe(true);
		playback.acknowledge(315, true);
		expect(await pause).toBe(true);
		expect(settled).toHaveBeenCalledTimes(1);
		expect(settled).toHaveBeenCalledWith({
			frameNumber: 315,
			playing: false,
		});
		expect(changed).toHaveBeenLastCalledWith(
			{ frameNumber: 315, playing: false },
			false,
		);
		expect(playback.active()).toBe(false);
		expect(start).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();
		expect(stopNativePlayback).toHaveBeenCalledTimes(1);
		expect(failed).not.toHaveBeenCalled();
	});

	it("keeps overlapping holds across replacement and ignores duplicate releases", async () => {
		const handoff = createPreparingHandoff();
		handoff.begin(position, 30, 120, "first");
		const original = deferred();
		const oldApproval = handoff.commitFrame(
			frame(315),
			bounds,
			() => original.promise,
		);
		expect(oldApproval).toBeDefined();
		const releaseFirst = handoff.holdFrames();
		const releaseSecond = handoff.holdFrames();
		handoff.begin({ ...position, playheadSeconds: 2 }, 30, 120, "second");
		const blockedApproval = vi.fn(async () => true);
		expect(
			handoff.commitFrame(frame(60), bounds, blockedApproval),
		).toBeUndefined();
		expect(releaseFirst()).toBe(true);
		expect(releaseFirst()).toBe(false);
		expect(
			handoff.commitFrame(frame(60), bounds, blockedApproval),
		).toBeUndefined();
		original.resolve(true);
		expect(await oldApproval).toBe(false);
		expect(
			handoff.commitFrame(frame(60), bounds, blockedApproval),
		).toBeUndefined();
		expect(blockedApproval).not.toHaveBeenCalled();
		expect(releaseSecond()).toBe(true);
		const replacement = deferred();
		const newApproval = handoff.commitFrame(
			frame(60),
			bounds,
			() => replacement.promise,
		);
		expect(newApproval).toBeDefined();
		expect(releaseFirst()).toBe(false);
		expect(releaseSecond()).toBe(false);
		replacement.resolve(true);
		expect(await newApproval).toBe(true);
	});

	it("resets a completed latch only for a different supplied identity", async () => {
		const handoff = createPreparingHandoff();
		const initial = handoff.begin(position, 30, 120, "first");
		expect(
			await handoff.commitFrame(frame(315), bounds, async () => true),
		).toBe(true);
		const later = { ...position, playheadSeconds: 12 };
		expect(handoff.begin(later, 60, 60, "first")).toBe(initial);
		expect(handoff.begin(later, 60, 60)).toBe(initial);
		expect(
			handoff.commitFrame(frame(315), bounds, async () => true),
		).toBeUndefined();
		expect(handoff.begin(later, 30, 120, "second")?.frameNumber).toBe(360);
		expect(
			await handoff.commitFrame(frame(360), bounds, async () => true),
		).toBe(true);
	});

	it("rejects a late positive ACK without clearing the new identity's pending approval", async () => {
		const handoff = createPreparingHandoff();
		const first = deferred();
		const second = deferred();
		handoff.begin(position, 30, 120, "first");
		const oldApproval = handoff.commitFrame(
			frame(315),
			bounds,
			() => first.promise,
		);
		handoff.begin({ ...position, playheadSeconds: 2 }, 30, 120, "second");
		const newApproval = handoff.commitFrame(
			frame(60),
			bounds,
			() => second.promise,
		);
		expect(newApproval).toBeDefined();
		first.resolve(true);
		expect(await oldApproval).toBe(false);
		const duplicate = vi.fn(async () => true);
		expect(handoff.commitFrame(frame(60), bounds, duplicate)).toBeUndefined();
		expect(duplicate).not.toHaveBeenCalled();
		second.resolve(true);
		expect(await newApproval).toBe(true);
	});

	it("invalidates pending approval when a scrub changes the expected frame", async () => {
		const handoff = createPreparingHandoff();
		const acknowledgement = deferred();
		handoff.begin(position, 30, 120, "first");
		const approval = handoff.commitFrame(
			frame(315),
			bounds,
			() => acknowledgement.promise,
		);
		handoff.requestFrame(45);
		acknowledgement.resolve(true);
		expect(await approval).toBe(false);
		expect(handoff.matches(frame(45), bounds)).toBe(true);
		expect(await handoff.commitFrame(frame(45), bounds, async () => true)).toBe(
			true,
		);
	});

	it("invalidates a pending playing-frame ACK when pause keeps the same target", async () => {
		const handoff = createPreparingHandoff();
		const acknowledgement = deferred();
		handoff.begin(position, 30, 120, "first");
		handoff.setAdvancing(true, 315);
		const approval = handoff.commitFrame(
			frame(315),
			bounds,
			() => acknowledgement.promise,
		);
		handoff.setAdvancing(false, 315);
		acknowledgement.resolve(true);
		expect(await approval).toBe(false);
		expect(
			await handoff.commitFrame(frame(315), bounds, async () => true),
		).toBe(true);
	});

	it("invalidates a same-frame pause ACK without changing the target or completed latch", async () => {
		const handoff = createPreparingHandoff();
		const first = deferred();
		const second = deferred();
		const initial = handoff.begin(position, 30, 120, "first");
		const oldApproval = handoff.commitFrame(
			frame(315),
			bounds,
			() => first.promise,
		);
		handoff.invalidatePending();
		expect(handoff.target()).toBe(initial);
		expect(handoff.requestedFrame()).toBe(315);
		const newApproval = handoff.commitFrame(
			frame(315),
			bounds,
			() => second.promise,
		);
		expect(newApproval).toBeDefined();
		first.resolve(true);
		expect(await oldApproval).toBe(false);
		expect(
			handoff.commitFrame(frame(315), bounds, async () => true),
		).toBeUndefined();
		second.resolve(true);
		expect(await newApproval).toBe(true);
		handoff.invalidatePending();
		expect(handoff.target()).toBe(initial);
		expect(
			handoff.commitFrame(frame(315), bounds, async () => true),
		).toBeUndefined();
	});

	it("requires matching visible bounds and leaves a rejected approval retryable", async () => {
		const handoff = createPreparingHandoff();
		const approve = vi.fn(async () => false);
		expect(handoff.commitFrame(frame(315), bounds, approve)).toBeUndefined();
		handoff.begin(position, 30, 120, "first");
		for (const invalid of [
			{ width: 0, height: 462 },
			{ width: 787, height: Number.NaN },
			{ width: -1, height: 462 },
		]) {
			expect(handoff.commitFrame(frame(315), invalid, approve)).toBeUndefined();
		}
		expect(handoff.commitFrame(frame(0), bounds, approve)).toBeUndefined();
		expect(approve).not.toHaveBeenCalled();
		expect(await handoff.commitFrame(frame(315), bounds, approve)).toBe(false);
		expect(approve).toHaveBeenCalledTimes(1);
		expect(
			await handoff.commitFrame(frame(315), bounds, async () => true),
		).toBe(true);
	});

	it("keeps one approval pending through same-frame and same-identity updates", async () => {
		const handoff = createPreparingHandoff();
		const acknowledgement = deferred();
		const approve = vi.fn(() => acknowledgement.promise);
		const initial = handoff.begin(position, 30, 120, "first");
		const approval = handoff.commitFrame(frame(315), bounds, approve);
		handoff.requestFrame(315);
		handoff.setAdvancing(false, 315);
		expect(
			handoff.begin({ ...position, playheadSeconds: 15 }, 30, 120, "first"),
		).toBe(initial);
		expect(handoff.commitFrame(frame(315), bounds, approve)).toBeUndefined();
		expect(approve).toHaveBeenCalledTimes(1);
		acknowledgement.resolve(true);
		expect(await approval).toBe(true);
	});

	it("commits a valid advancing frame once and rejects a duplicate completion", async () => {
		const handoff = createPreparingHandoff();
		const approve = vi.fn(async () => true);
		handoff.begin(position, 30, 120, "first");
		handoff.setAdvancing(true, 315);
		for (const invalid of [Number.NaN, 315.5, Number.POSITIVE_INFINITY]) {
			expect(
				handoff.commitFrame(frame(invalid), bounds, approve),
			).toBeUndefined();
		}
		expect(handoff.commitFrame(frame(314), bounds, approve)).toBeUndefined();
		expect(handoff.commitFrame(frame(3600), bounds, approve)).toBeUndefined();
		expect(await handoff.commitFrame(frame(319), bounds, approve)).toBe(true);
		expect(handoff.commitFrame(frame(320), bounds, approve)).toBeUndefined();
		expect(handoff.accept(frame(320), bounds)).toBe(false);
		expect(approve).toHaveBeenCalledTimes(1);
	});

	it("propagates a current rejection and clears its pending slot for retry", async () => {
		const handoff = createPreparingHandoff();
		const acknowledgement = deferred();
		const error = new Error("backend rejected instance");
		handoff.begin(position, 30, 120, "first");
		const approval = handoff.commitFrame(
			frame(315),
			bounds,
			() => acknowledgement.promise,
		);
		const rejected = expect(approval).rejects.toBe(error);
		acknowledgement.reject(error);
		await rejected;
		expect(
			await handoff.commitFrame(frame(315), bounds, async () => true),
		).toBe(true);
	});

	it("turns a superseded rejection into false without poisoning the new identity", async () => {
		const handoff = createPreparingHandoff();
		const first = deferred();
		const second = deferred();
		handoff.begin(position, 30, 120, "first");
		const oldApproval = handoff.commitFrame(
			frame(315),
			bounds,
			() => first.promise,
		);
		handoff.begin(position, 30, 120, "second");
		const newApproval = handoff.commitFrame(
			frame(315),
			bounds,
			() => second.promise,
		);
		first.reject(new Error("old instance ended"));
		expect(await oldApproval).toBe(false);
		const duplicate = vi.fn(async () => true);
		expect(handoff.commitFrame(frame(315), bounds, duplicate)).toBeUndefined();
		expect(duplicate).not.toHaveBeenCalled();
		second.resolve(true);
		expect(await newApproval).toBe(true);
	});
});
