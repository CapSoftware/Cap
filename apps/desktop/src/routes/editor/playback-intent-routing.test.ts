import { describe, expect, it, vi } from "vitest";
import { routeEditorPlaybackIntent } from "./playback-intent-routing";
import { createPreparingPlaybackHandoff } from "./preparing-playback-handoff";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function harness() {
	const started = deferred();
	const stopped = deferred();
	const start = vi.fn(async (_frameNumber: number) => {});
	start.mockImplementationOnce(() => started.promise);
	const stop = vi.fn(() => stopped.promise);
	const settled = vi.fn();
	const handoff = createPreparingPlaybackHandoff({
		initial: { frameNumber: 600, playing: true },
		start,
		stop,
		changed: vi.fn(),
		settled,
		failed: vi.fn(),
	});
	const request = (playing: boolean, seconds = 20) =>
		handoff.request({ frameNumber: Math.floor(seconds * 30), playing });
	const ordinary = vi.fn(async () => {});
	return { handoff, request, ordinary, started, stopped, start, stop, settled };
}

async function flush() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("panel playback intent routing", () => {
	it("transcript word seek stops a pending resume and waits for the new actual frame", async () => {
		const value = harness();
		value.handoff.acknowledge(600);
		const seek = routeEditorPlaybackIntent(
			value.request,
			{ playing: false, seconds: 7 },
			value.ordinary,
		);
		value.started.resolve();
		await flush();
		expect(value.stop).toHaveBeenCalledTimes(1);
		expect(value.ordinary).not.toHaveBeenCalled();
		value.stopped.resolve();
		await flush();
		expect(value.settled).not.toHaveBeenCalled();
		value.handoff.acknowledge(210);
		expect(await seek).toBe(true);
		expect(value.settled.mock.calls).toEqual([
			[{ frameNumber: 210, playing: false }],
		]);
		expect(value.start).toHaveBeenCalledTimes(1);
		value.handoff.dispose();
	});

	it("record or import cannot continue before captured playback has actually stopped", async () => {
		const value = harness();
		const mutate = vi.fn();
		value.handoff.acknowledge(600);
		const change = routeEditorPlaybackIntent(
			value.request,
			{ playing: false },
			value.ordinary,
		).then((accepted) => {
			if (accepted) mutate();
		});
		value.started.resolve();
		await flush();
		expect(mutate).not.toHaveBeenCalled();
		expect(value.ordinary).not.toHaveBeenCalled();
		value.stopped.resolve();
		await change;
		expect(mutate).toHaveBeenCalledTimes(1);
		value.handoff.dispose();
	});

	it("a newer transcript Play supersedes an import pause without invoking ordinary commands", async () => {
		const value = harness();
		const pause = routeEditorPlaybackIntent(
			value.request,
			{ playing: false },
			value.ordinary,
		);
		const play = routeEditorPlaybackIntent(
			value.request,
			{ playing: true },
			value.ordinary,
		);
		expect(await pause).toBe(false);
		value.handoff.acknowledge(600);
		value.started.resolve();
		expect(await play).toBe(true);
		expect(value.ordinary).not.toHaveBeenCalled();
		value.handoff.dispose();
	});

	it("owner disposal declines queued record/import and never falls through to ordinary playback", async () => {
		const value = harness();
		const pause = routeEditorPlaybackIntent(
			value.request,
			{ playing: false },
			value.ordinary,
		);
		value.handoff.dispose();
		expect(await pause).toBe(false);
		expect(value.start).not.toHaveBeenCalled();
		expect(value.ordinary).not.toHaveBeenCalled();
	});

	it("transcript replay requests frame zero through the queue at the actual end", async () => {
		const value = harness();
		const replay = routeEditorPlaybackIntent(
			value.request,
			{ playing: true, seconds: 0 },
			value.ordinary,
		);
		value.handoff.acknowledge(600);
		expect(value.start).not.toHaveBeenCalled();
		value.handoff.acknowledge(0);
		value.started.resolve();
		expect(await replay).toBe(true);
		expect(value.start.mock.calls).toEqual([[0]]);
		expect(value.ordinary).not.toHaveBeenCalled();
		value.handoff.dispose();
	});

	it("ordinary behavior keeps its command order and completes only after its own acknowledgement", async () => {
		const stopped = deferred();
		const calls: string[] = [];
		const routed = routeEditorPlaybackIntent(
			() => undefined,
			{ playing: false, seconds: 7 },
			async () => {
				calls.push("stop");
				await stopped.promise;
				calls.push("seek");
			},
		);
		expect(calls).toEqual(["stop"]);
		stopped.resolve();
		expect(await routed).toBe(true);
		expect(calls).toEqual(["stop", "seek"]);
	});

	it("ordinary stop failures reject rather than admitting a project mutation", async () => {
		await expect(
			routeEditorPlaybackIntent(
				() => undefined,
				{ playing: false },
				async () => {
					throw new Error("stop failed");
				},
			),
		).rejects.toThrow("stop failed");
	});
});
