import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPreviewBoundsReaction,
	createPreviewBoundsUpdater,
	type PreviewBounds,
} from "./preview-bounds";

vi.mock("solid-js", () =>
	vi.importActual<typeof import("solid-js")>("solid-js/dist/solid.js"),
);

function harness() {
	let current = { width: 0, height: 0 };
	let measured: (PreviewBounds & { connected: boolean }) | undefined = {
		width: 835,
		height: 494,
		connected: true,
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const commit = vi.fn((bounds: PreviewBounds) => {
		current = bounds;
	});
	const cancel = vi.fn(() => clearTimeout(timer));
	const measure = vi.fn(() => measured);
	const defer = vi.fn((bounds: PreviewBounds) => {
		cancel();
		timer = setTimeout(() => commit(bounds), 100);
	});
	const frames = new Map<number, () => void>();
	let frameId = 0;
	const requestFrame = vi.fn((callback: () => void) => {
		frames.set(++frameId, callback);
		return frameId;
	});
	const cancelFrame = vi.fn((id: number) => frames.delete(id));
	const updater = createPreviewBoundsUpdater({
		current: () => current,
		measure,
		commit,
		defer,
		cancel,
		requestFrame,
		cancelFrame,
	});
	return {
		...updater,
		commit,
		defer,
		measure,
		cancel,
		requestFrame,
		cancelFrame,
		frameCount: () => frames.size,
		flushFrame() {
			const callbacks = [...frames.values()];
			frames.clear();
			for (const callback of callbacks) callback();
		},
		current: () => current,
		setMeasured(value: typeof measured) {
			measured = value;
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("preview first-frame bounds", () => {
	it("flushes the actual first-frame bounds and cancels a stale trailing write", () => {
		const state = harness();
		state.update({ width: 835, height: 542 }, false);
		state.update({ width: 820, height: 520 }, false);
		expect(vi.getTimerCount()).toBe(1);
		state.update({ width: 820, height: 520 }, true);
		expect(state.current()).toEqual({ width: 835, height: 494 });
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(1000);
		expect(state.commit.mock.calls).toEqual([
			[{ width: 835, height: 542 }],
			[{ width: 835, height: 494 }],
		]);
	});

	it("uses connected actual geometry when the frame is already present at mount", () => {
		const state = harness();
		state.update({ width: 835, height: 542 }, true);
		expect(state.current()).toEqual({ width: 835, height: 494 });
		expect(state.measure).toHaveBeenCalledTimes(1);
		expect(state.defer).not.toHaveBeenCalled();
	});

	it("does not consume the first-frame latch for disconnected or invalid geometry", () => {
		const invalid = [
			undefined,
			{ width: 835, height: 494, connected: false },
			{ width: 0, height: 494, connected: true },
			{ width: 835, height: -1, connected: true },
			{ width: Number.NaN, height: 494, connected: true },
			{ width: 835, height: Number.POSITIVE_INFINITY, connected: true },
		];
		for (const measured of invalid) {
			const state = harness();
			state.setMeasured(measured);
			state.update({ width: 0, height: 0 }, true);
			state.setMeasured({ width: 300, height: 600, connected: true });
			state.update({ width: 300, height: 620 }, true);
			expect(state.current()).toEqual({ width: 300, height: 600 });
			expect(state.measure).toHaveBeenCalledTimes(2);
			state.dispose();
		}
	});

	it("keeps later portrait and landscape resize bursts trailing by 100ms", () => {
		const state = harness();
		state.update({ width: 835, height: 542 }, true);
		state.flushFrame();
		state.update({ width: 300, height: 600 }, true);
		vi.advanceTimersByTime(75);
		state.update({ width: 900, height: 400 }, true);
		vi.advanceTimersByTime(99);
		expect(state.current()).toEqual({ width: 835, height: 494 });
		vi.advanceTimersByTime(1);
		expect(state.current()).toEqual({ width: 900, height: 400 });
		expect(state.measure).toHaveBeenCalledTimes(2);
	});

	it("cancels pending work on teardown and ignores later frame or bounds delivery", () => {
		const state = harness();
		state.update({ width: 835, height: 542 }, false);
		state.update({ width: 300, height: 600 }, false);
		state.dispose();
		state.update({ width: 900, height: 400 }, true);
		vi.advanceTimersByTime(1000);
		expect(state.current()).toEqual({ width: 835, height: 542 });
		expect(state.measure).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("settles without timer rearming and never repeats the first-frame flush", () => {
		const state = harness();
		state.update({ width: 835, height: 542 }, true);
		state.flushFrame();
		state.update({ width: 300, height: 600 }, false);
		state.update({ width: 300, height: 600 }, true);
		vi.advanceTimersByTime(100);
		const commits = state.commit.mock.calls.length;
		vi.advanceTimersByTime(10_000);
		expect(state.current()).toEqual({ width: 300, height: 600 });
		expect(state.commit).toHaveBeenCalledTimes(commits);
		expect(state.measure).toHaveBeenCalledTimes(2);
		expect(state.requestFrame).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("remeasures a same-turn layout change once before sealing initial geometry", () => {
		const state = harness();
		state.setMeasured({ width: 835, height: 542, connected: true });
		state.update({ width: 835, height: 542 }, true);
		expect(state.current()).toEqual({ width: 835, height: 542 });
		state.setMeasured({ width: 835, height: 494, connected: true });
		state.flushFrame();
		expect(state.current()).toEqual({ width: 835, height: 494 });
		expect(state.requestFrame).toHaveBeenCalledTimes(1);
		expect(state.frameCount()).toBe(0);
		state.update({ width: 900, height: 600 }, true);
		vi.advanceTimersByTime(99);
		expect(state.current()).toEqual({ width: 835, height: 494 });
		vi.advanceTimersByTime(1);
		expect(state.current()).toEqual({ width: 900, height: 600 });
		expect(state.requestFrame).toHaveBeenCalledTimes(1);
	});

	it("keeps initial updates eager without scheduling more than one frame", () => {
		const state = harness();
		state.update({ width: 835, height: 542 }, true);
		state.setMeasured({ width: 700, height: 400, connected: true });
		state.update({ width: 700, height: 420 }, true);
		expect(state.current()).toEqual({ width: 700, height: 400 });
		expect(state.defer).not.toHaveBeenCalled();
		expect(state.requestFrame).toHaveBeenCalledTimes(1);
		state.flushFrame();
		vi.advanceTimersByTime(10_000);
		expect(state.frameCount()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("leaves invalid scheduled geometry eligible without a frame polling loop", () => {
		const state = harness();
		state.update({ width: 835, height: 542 }, true);
		state.setMeasured({ width: 0, height: 0, connected: false });
		state.flushFrame();
		expect(state.frameCount()).toBe(0);
		expect(state.requestFrame).toHaveBeenCalledTimes(1);
		state.setMeasured({ width: 300, height: 600, connected: true });
		state.update({ width: 300, height: 620 }, true);
		expect(state.current()).toEqual({ width: 300, height: 600 });
		expect(state.requestFrame).toHaveBeenCalledTimes(2);
		state.flushFrame();
		expect(state.frameCount()).toBe(0);
	});

	it("cancels the scheduled frame on teardown without permitting a late commit", () => {
		const state = harness();
		state.update({ width: 835, height: 542 }, true);
		const queued = state.requestFrame.mock.calls[0][0];
		expect(state.frameCount()).toBe(1);
		state.dispose();
		expect(state.cancelFrame).toHaveBeenCalledTimes(1);
		expect(state.frameCount()).toBe(0);
		state.setMeasured({ width: 900, height: 400, connected: true });
		queued();
		state.update({ width: 900, height: 400 }, true);
		expect(state.current()).toEqual({ width: 835, height: 494 });
		expect(state.commit).toHaveBeenCalledTimes(1);
	});
});

describe("preview bounds reactive ownership", () => {
	it("does not rearm a pending resize for repeated non-null frame objects", () => {
		const state = harness();
		const reactive = createRoot((dispose) => {
			const [bounds, setBounds] = createSignal({ width: 835, height: 542 });
			const [frame, setFrame] = createSignal<{ index: number } | null>(null);
			const hasFrame = createPreviewBoundsReaction({
				bounds,
				hasFrame: () => frame() !== null,
				updater: state,
			});
			return { setBounds, setFrame, hasFrame, dispose };
		});
		expect(state.commit).toHaveBeenCalledTimes(1);
		expect(state.current()).toEqual({ width: 835, height: 542 });
		expect(reactive.hasFrame()).toBe(false);
		reactive.setFrame({ index: 0 });
		expect(state.current()).toEqual({ width: 835, height: 494 });
		expect(reactive.hasFrame()).toBe(true);
		state.flushFrame();
		reactive.setBounds({ width: 900, height: 600 });
		for (let index = 1; index <= 10; index++) {
			vi.advanceTimersByTime(20);
			reactive.setFrame({ index });
		}
		expect(state.defer).toHaveBeenCalledTimes(1);
		expect(state.current()).toEqual({ width: 900, height: 600 });
		expect(state.measure).toHaveBeenCalledTimes(2);
		expect(state.requestFrame).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		reactive.setBounds({ width: 400, height: 800 });
		expect(vi.getTimerCount()).toBe(1);
		reactive.dispose();
		reactive.setBounds({ width: 500, height: 900 });
		reactive.setFrame(null);
		vi.advanceTimersByTime(10_000);
		expect(state.current()).toEqual({ width: 900, height: 600 });
		expect(state.defer).toHaveBeenCalledTimes(2);
		expect(state.commit).toHaveBeenCalledTimes(4);
		expect(vi.getTimerCount()).toBe(0);
	});
});
