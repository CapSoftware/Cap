import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { PreparingEditorChanged } from "~/utils/tauri";
import { createPreparingEditorModel } from "./preparing-editor-model";
import { createPreparingEditorSubscription } from "./preparing-editor-subscription";

vi.mock("solid-js", () =>
	vi.importActual<typeof import("solid-js")>("solid-js/dist/solid.js"),
);

function state(sequence = 1): PreparingEditorChanged {
	return {
		requestEpoch: 19,
		jobId: "current-job",
		sequence,
		fps: 30,
		progress: {
			totalDuration: 120,
			playableUntil: 20,
			previewAvailable: true,
			phase: "preparing",
		},
		playback: { playheadSeconds: 0, playing: false, buffering: false },
		seed: { title: "Recording", tracks: ["display"] },
	};
}

function harness() {
	let disposeOwner = () => {};
	const model = createRoot((dispose) => {
		disposeOwner = dispose;
		return createPreparingEditorModel();
	});
	const unlisten = vi.fn();
	let emit = (_snapshot: PreparingEditorChanged) => {};
	const listen = vi.fn(async (accept: typeof emit): Promise<() => void> => {
		emit = accept;
		return unlisten;
	});
	const getState = vi.fn(
		async (): Promise<PreparingEditorChanged | null> => state(),
	);
	const seek = vi.fn(async (_seconds: number) => {});
	const subscription = createPreparingEditorSubscription({
		requestEpoch: 19,
		model,
		listen,
		getState,
		controller: () => ({ seek, setPlaying: async () => {} }),
	});
	return {
		model,
		subscription,
		listen,
		unlisten,
		getState,
		seek,
		emit: (value: PreparingEditorChanged) => emit(value),
		dispose() {
			subscription.dispose();
			model.dispose();
			disposeOwner();
		},
	};
}

describe("preparing editor native subscription", () => {
	it("uses the actual bound FPS and accepts only this request epoch", async () => {
		const value = harness();
		await value.subscription.listen();
		value.emit({ ...state(), requestEpoch: 18 });
		expect(value.model.progress().totalDuration).toBeNull();
		value.emit(state());
		value.model.setRendered(true);
		expect(await value.model.seek(20)).toBe(true);
		expect(value.seek).toHaveBeenCalledWith(599 / 30);
		value.dispose();
	});

	it("catches an offer before URL attachment without reverting a newer event", async () => {
		const value = harness();
		await value.subscription.listen();
		const latest = state(3);
		latest.progress.playableUntil = 40;
		value.emit(latest);
		expect(await value.subscription.refresh()).toBe(false);
		expect(value.model.timeline().playableUntil).toBe(40);
		value.dispose();
	});

	it("loads the retained native state when the offer precedes the event listener", async () => {
		const value = harness();
		await value.subscription.listen();
		expect(await value.subscription.refresh()).toBe(true);
		expect(value.model.timeline().playableUntil).toBe(20);
		value.dispose();
	});

	it("never rebinds to another job or FPS after admission", async () => {
		const value = harness();
		await value.subscription.listen();
		value.emit(state());
		value.emit({ ...state(2), jobId: "stale-job" });
		value.emit({ ...state(3), fps: 60 });
		expect(value.model.progress()).toEqual(state().progress);
		expect(
			value.subscription.accept({
				...state(4),
				progress: { ...state().progress, phase: "handoff" },
			}),
		).toBe(true);
		value.dispose();
	});

	it("consumes the joined final snapshot before ordinary handoff without waiting for events", () => {
		const value = harness();
		const final = state(8);
		final.progress.phase = "handoff";
		final.playback = { playheadSeconds: 19.5, playing: true, buffering: false };
		expect(value.subscription.accept(final)).toBe(true);
		expect(value.model.playback()).toEqual(final.playback);
		expect(value.model.canPlay()).toBe(false);
		value.dispose();
	});

	it("narrows native track names without adding undeclared tracks", () => {
		const value = harness();
		const next = state();
		next.seed.tracks = ["display", "future-track", "microphone"];
		value.subscription.accept(next);
		expect(value.model.seed().tracks).toEqual(["display", "microphone"]);
		value.dispose();
	});

	it("cleans a listener that resolves after the window owner closes", async () => {
		const value = harness();
		let resolve!: (cleanup: () => void) => void;
		value.listen.mockImplementation(
			() =>
				new Promise((ready) => {
					resolve = ready;
				}),
		);
		const pending = value.subscription.listen();
		value.dispose();
		resolve(value.unlisten);
		expect(await pending).toBe(false);
		expect(value.unlisten).toHaveBeenCalledTimes(1);
	});

	it("ignores a late retained-state response after the window owner closes", async () => {
		const value = harness();
		let resolve!: (snapshot: PreparingEditorChanged) => void;
		value.getState.mockImplementation(
			() =>
				new Promise((ready) => {
					resolve = ready;
				}),
		);
		const pending = value.subscription.refresh();
		value.dispose();
		resolve(state());
		expect(await pending).toBe(false);
		expect(value.model.progress().totalDuration).toBeNull();
	});

	it("does not create duplicate listeners and cleans successful registration once", async () => {
		const value = harness();
		expect(await value.subscription.listen()).toBe(true);
		expect(await value.subscription.listen()).toBe(true);
		expect(value.listen).toHaveBeenCalledTimes(1);
		value.dispose();
		value.subscription.dispose();
		expect(value.unlisten).toHaveBeenCalledTimes(1);
	});

	it("declines a listener setup failure without starting a transport", async () => {
		const value = harness();
		value.listen.mockRejectedValue(new Error("window ended"));
		expect(await value.subscription.listen()).toBe(false);
		expect(value.getState).not.toHaveBeenCalled();
		expect(value.model.canPlay()).toBe(false);
		value.dispose();
	});
	it("releases the native listener after failed admission but accepts the joined synchronous snapshot", async () => {
		const value = harness();
		await value.subscription.listen();
		value.subscription.stopListening();
		expect(value.unlisten).toHaveBeenCalledTimes(1);
		const final = state(2);
		final.progress.phase = "handoff";
		final.playback.playheadSeconds = 12;
		expect(value.subscription.accept(final)).toBe(true);
		expect(value.model.playback().playheadSeconds).toBe(12);
		value.dispose();
		expect(value.unlisten).toHaveBeenCalledTimes(1);
	});
});
