import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
	createPreparingEditorModel,
	type PreparingEditorSnapshot,
	preparingTime,
	preparingTimeline,
} from "./preparing-editor-model";

vi.mock("solid-js", () =>
	vi.importActual<typeof import("solid-js")>("solid-js/dist/solid.js"),
);

const identity = { requestEpoch: 17, jobId: "actual-finalization-job" };
function snapshot(sequence = 0): PreparingEditorSnapshot {
	return {
		...identity,
		sequence,
		progress: {
			totalDuration: 120,
			playableUntil: 20,
			previewAvailable: true,
			phase: "preparing",
		},
		playback: { playheadSeconds: 0, playing: false, buffering: false },
	};
}

function harness() {
	let cleanup = () => {};
	const model = createRoot((dispose) => {
		cleanup = dispose;
		return createPreparingEditorModel();
	});
	const controller = {
		seek: vi.fn(async (_seconds: number) => {}),
		setPlaying: vi.fn(async (_playing: boolean) => {}),
	};
	expect(model.bind(identity, controller, 60)).toBe(true);
	return {
		model,
		controller,
		dispose() {
			model.dispose();
			cleanup();
		},
	};
}

describe("preparing editor confirmed readiness", () => {
	it("starts without an invented duration, playable prefix or controller action", async () => {
		const value = harness();
		expect(value.model.timeline()).toEqual({
			totalDuration: null,
			playableUntil: 0,
			fraction: null,
		});
		expect(await value.model.seek(10)).toBe(false);
		expect(await value.model.setPlaying(true)).toBe(false);
		expect(value.controller.seek).not.toHaveBeenCalled();
		value.dispose();
	});

	it("keeps an actual first image independent from audio playback readiness", async () => {
		const value = harness();
		const next = snapshot();
		next.progress.playableUntil = 0;
		value.model.accept(next);
		value.model.setRendered(true);
		expect(value.model.rendered()).toBe(true);
		expect(value.model.canPlay()).toBe(false);
		expect(await value.model.setPlaying(true)).toBe(false);
		value.dispose();
	});

	it("rejects foreign, duplicate and out-of-order updates before changing the frontier", () => {
		const value = harness();
		expect(value.model.accept(snapshot(2))).toBe(true);
		for (const next of [
			snapshot(2),
			snapshot(1),
			{ ...snapshot(3), jobId: "other" },
			{ ...snapshot(3), requestEpoch: 18 },
		]) {
			next.progress.playableUntil = 120;
			expect(value.model.accept(next)).toBe(false);
		}
		expect(value.model.timeline().playableUntil).toBe(20);
		expect(
			value.model.bind(
				{ ...identity, jobId: "replacement" },
				value.controller,
				60,
			),
		).toBe(false);
		value.dispose();
	});

	it("clamps actual seek requests to the confirmed prefix without optimistic state", async () => {
		const value = harness();
		value.model.accept(snapshot());
		value.model.setRendered(true);
		expect(await value.model.seek(90)).toBe(true);
		expect(value.controller.seek).toHaveBeenCalledWith(1199 / 60);
		expect(value.model.playback().playheadSeconds).toBe(0);
		expect(await value.model.setPlaying(true)).toBe(true);
		expect(value.model.playback().playing).toBe(false);
		for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			expect(await value.model.seek(invalid)).toBe(false);
		}
		expect(value.controller.seek).toHaveBeenCalledTimes(1);
		value.dispose();
	});

	it("revokes playback on a later failure while retaining the displayed image", async () => {
		const value = harness();
		value.model.accept(snapshot());
		value.model.setRendered(true);
		const failed = snapshot(1);
		failed.progress.phase = "unavailable";
		value.model.accept(failed);
		expect(value.model.timeline().playableUntil).toBe(0);
		expect(value.model.rendered()).toBe(true);
		expect(await value.model.setPlaying(true)).toBe(false);
		value.dispose();
	});

	it("keeps unknown duration unscaled and without claimed playability", () => {
		const value = snapshot().progress;
		value.totalDuration = null;
		expect(preparingTimeline(value)).toEqual({
			totalDuration: null,
			playableUntil: 0,
			fraction: null,
		});
		value.totalDuration = 5;
		expect(preparingTimeline(value).fraction).toBe(1);
	});

	it("holds the backend playhead and playing intent during handoff without accepting new commands", async () => {
		const value = harness();
		const next = snapshot();
		next.progress.phase = "handoff";
		next.playback = { playheadSeconds: 12.75, playing: true, buffering: false };
		value.model.accept(next);
		value.model.setRendered(true);
		expect(value.model.playback()).toEqual(next.playback);
		expect(await value.model.seek(2)).toBe(false);
		expect(await value.model.setPlaying(true)).toBe(false);
		value.dispose();
	});

	it("fails closed for invalid confirmed data and never retains earlier playability", () => {
		const value = harness();
		value.model.accept(snapshot());
		value.model.setRendered(true);
		const invalid = snapshot(1);
		invalid.progress.totalDuration = Number.NaN;
		expect(value.model.accept(invalid)).toBe(false);
		expect(value.model.progress().phase).toBe("unavailable");
		expect(value.model.canPlay()).toBe(false);
		expect(value.model.timeline().playableUntil).toBe(0);
		value.dispose();
	});

	it("does not publish a late command error after the window owner is disposed", async () => {
		const value = harness();
		let reject!: (error: Error) => void;
		value.controller.seek.mockImplementation(
			() =>
				new Promise<void>((_, fail) => {
					reject = fail;
				}),
		);
		value.model.accept(snapshot());
		value.model.setRendered(true);
		const pending = value.model.seek(3);
		expect(value.model.commandPending()).toBe(true);
		expect(await value.model.seek(4)).toBe(false);
		value.dispose();
		reject(new Error("window closed"));
		expect(await pending).toBe(false);
		expect(value.model.commandError()).toBeUndefined();
		expect(value.model.accept(snapshot(3))).toBe(false);
	});

	it("copies readonly seed data instead of retaining a mutable external tracks array", () => {
		const value = harness();
		const tracks: ("display" | "camera")[] = ["display"];
		value.model.accept({
			...snapshot(),
			seed: { title: "My recording", tracks },
		});
		tracks.push("camera");
		expect(value.model.seed().tracks).toEqual(["display"]);
		value.dispose();
	});

	it.each([null, 0, 10])(
		"rejects a positive prefix inconsistent with duration %s",
		(duration) => {
			const value = harness();
			const next = snapshot();
			next.progress.totalDuration = duration;
			value.model.setRendered(true);
			expect(value.model.accept(next)).toBe(false);
			expect(value.model.canPlay()).toBe(false);
			expect(value.model.timeline().playableUntil).toBe(0);
			value.dispose();
		},
	);

	it.each([20, 20.001, 1 / 120])(
		"seeks to an actual frame strictly before exclusive prefix %s",
		async (prefix) => {
			const value = harness();
			const next = snapshot();
			next.progress.playableUntil = prefix;
			value.model.accept(next);
			value.model.setRendered(true);
			expect(await value.model.seek(prefix)).toBe(true);
			const target = value.controller.seek.mock.calls[0][0];
			expect(target).toBeLessThan(prefix);
			expect(target * 60).toBeCloseTo(Math.ceil(prefix * 60) - 1);
			value.dispose();
		},
	);

	it.each([120, 119.95])(
		"replays from zero at completed recording end %s",
		async (playheadSeconds) => {
			const value = harness();
			const next = snapshot();
			next.progress.playableUntil = 120;
			next.playback.playheadSeconds = playheadSeconds;
			value.model.accept(next);
			value.model.setRendered(true);
			expect(await value.model.setPlaying(true)).toBe(true);
			expect(value.controller.seek).toHaveBeenCalledWith(0);
			expect(value.controller.seek.mock.invocationCallOrder[0]).toBeLessThan(
				value.controller.setPlaying.mock.invocationCallOrder[0],
			);
			value.dispose();
		},
	);

	it("does not rewind at an incomplete playable frontier", async () => {
		const value = harness();
		const next = snapshot();
		next.playback.playheadSeconds = 19.95;
		value.model.accept(next);
		value.model.setRendered(true);
		expect(await value.model.setPlaying(true)).toBe(true);
		expect(value.controller.seek).not.toHaveBeenCalled();
		value.dispose();
	});

	it("does not start after a replay seek if handoff or disposal wins", async () => {
		for (const end of ["handoff", "dispose"]) {
			const value = harness();
			let finish!: () => void;
			value.controller.seek.mockImplementation(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve;
					}),
			);
			const next = snapshot();
			next.progress.playableUntil = 120;
			next.playback.playheadSeconds = 120;
			value.model.accept(next);
			value.model.setRendered(true);
			const pending = value.model.setPlaying(true);
			expect(value.model.commandPending()).toBe(true);
			if (end === "dispose") value.dispose();
			else
				value.model.accept({
					...next,
					sequence: 1,
					progress: { ...next.progress, phase: "handoff" },
				});
			finish();
			expect(await pending).toBe(false);
			expect(value.controller.setPlaying).not.toHaveBeenCalled();
			if (end !== "dispose") value.dispose();
		}
	});

	it("formats long recording times without wrapping hours or displaying invalid numbers", () => {
		expect(preparingTime(7200.99)).toBe("2:00:00");
		expect(preparingTime(3661)).toBe("1:01:01");
		expect(preparingTime(Number.NaN)).toBe("0:00");
	});
});
