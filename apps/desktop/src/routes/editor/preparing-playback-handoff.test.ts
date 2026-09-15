import { describe, expect, it, vi } from "vitest";
import { createPreparingPlaybackHandoff } from "./preparing-playback-handoff";

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function harness() {
	const firstStart = deferred();
	const start = vi.fn(async (_frame: number) => {});
	start.mockImplementationOnce(() => firstStart.promise);
	const stop = vi.fn(async () => {});
	const changed = vi.fn();
	const settled = vi.fn();
	const failed = vi.fn();
	const handoff = createPreparingPlaybackHandoff({
		initial: { frameNumber: 600, playing: true },
		start,
		stop,
		changed,
		settled,
		failed,
	});
	return { handoff, firstStart, start, stop, changed, settled, failed };
}

const flush = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("ordinary playback handoff ordering", () => {
	it("uses the actually presented moving frame after native adoption", async () => {
		const value = harness();
		value.handoff.acknowledge(612, true);
		expect(value.start.mock.calls).toEqual([[612]]);
		value.firstStart.resolve();
		await flush();
		expect(value.settled.mock.calls).toEqual([
			[{ frameNumber: 612, playing: true }],
		]);
		value.handoff.dispose();
		expect(value.stop).not.toHaveBeenCalled();
	});

	it("starts only after the actual retained target frame is acknowledged", async () => {
		const value = harness();
		value.handoff.acknowledge(0);
		expect(value.start).not.toHaveBeenCalled();
		value.handoff.acknowledge(600);
		expect(value.start.mock.calls).toEqual([[600]]);
		value.firstStart.resolve();
		await flush();
		expect(value.settled.mock.calls).toEqual([
			[{ frameNumber: 600, playing: true }],
		]);
		expect(value.handoff.active()).toBe(false);
		value.handoff.dispose();
	});

	it("a later pause wins even when the native start acknowledgement is deferred", async () => {
		const value = harness();
		value.handoff.acknowledge(600);
		const pause = value.handoff.request({ frameNumber: 600, playing: false });
		value.firstStart.resolve();
		expect(await pause).toBe(true);
		expect(value.stop).toHaveBeenCalledTimes(1);
		expect(value.settled.mock.calls).toEqual([
			[{ frameNumber: 600, playing: false }],
		]);
		value.handoff.dispose();
	});

	it("a new seek keeps playing intent and waits for that new frame before starting", async () => {
		const value = harness();
		value.handoff.retarget(1200);
		value.handoff.acknowledge(600);
		expect(value.start).not.toHaveBeenCalled();
		expect(value.handoff.intent().playing).toBe(true);
		value.handoff.acknowledge(1200);
		expect(value.start.mock.calls).toEqual([[1200]]);
		value.firstStart.resolve();
		await flush();
		value.handoff.dispose();
	});

	it("coalesces newer seeks while an old start is in flight without replaying intermediate targets", async () => {
		const value = harness();
		value.handoff.acknowledge(600);
		const skipped = value.handoff.request({ frameNumber: 900, playing: true });
		const latest = value.handoff.request({ frameNumber: 1200, playing: true });
		expect(await skipped).toBe(false);
		value.firstStart.resolve();
		await flush();
		expect(value.stop).toHaveBeenCalledTimes(1);
		expect(value.start).toHaveBeenCalledTimes(1);
		value.handoff.acknowledge(1200);
		expect(await latest).toBe(true);
		expect(value.start.mock.calls).toEqual([[600], [1200]]);
		value.handoff.dispose();
	});

	it("same-frame color or layout updates do not erase playing intent or rearm a started request", async () => {
		const value = harness();
		value.handoff.acknowledge(600);
		value.handoff.retarget(600);
		value.firstStart.resolve();
		await flush();
		expect(value.start).toHaveBeenCalledTimes(1);
		expect(value.settled.mock.calls).toEqual([
			[{ frameNumber: 600, playing: true }],
		]);
		value.handoff.dispose();
	});

	it("stops the captured native instance after a start resolves following owner disposal", async () => {
		const value = harness();
		value.handoff.acknowledge(600);
		value.handoff.dispose();
		value.firstStart.resolve();
		await flush();
		expect(value.stop).toHaveBeenCalledTimes(1);
		expect(value.settled).not.toHaveBeenCalled();
		expect(
			value.handoff.request({ frameNumber: 0, playing: true }),
		).toBeUndefined();
	});

	it("disposal before the frame acknowledgement never starts playback", async () => {
		const value = harness();
		value.handoff.dispose();
		value.handoff.acknowledge(600);
		await flush();
		expect(value.start).not.toHaveBeenCalled();
		expect(value.stop).not.toHaveBeenCalled();
	});

	it("a failed native start is cleaned up and never published as playing", async () => {
		const value = harness();
		value.handoff.acknowledge(600);
		value.firstStart.reject(new Error("native start failed"));
		await flush();
		expect(value.stop).toHaveBeenCalledTimes(1);
		expect(value.failed).toHaveBeenCalledTimes(1);
		expect(value.settled).not.toHaveBeenCalled();
		value.handoff.dispose();
	});
	it("keeps a newer Play in the owned queue until failed-start cleanup has actually completed", async () => {
		const value = harness();
		const cleanup = deferred();
		value.stop.mockImplementationOnce(() => cleanup.promise);
		value.handoff.acknowledge(600);
		value.firstStart.reject(new Error("start failed"));
		await flush();
		expect(value.stop).toHaveBeenCalledTimes(1);
		expect(value.handoff.active()).toBe(true);
		const newer = value.handoff.request({ frameNumber: 600, playing: true });
		expect(newer).toBeDefined();
		expect(value.start).toHaveBeenCalledTimes(1);
		cleanup.resolve();
		expect(await newer).toBe(true);
		expect(value.start.mock.calls).toEqual([[600], [600]]);
		expect(value.stop).toHaveBeenCalledTimes(1);
		expect(value.settled.mock.calls).toEqual([
			[{ frameNumber: 600, playing: true }],
		]);
		value.handoff.dispose();
	});
	it("transfers a settled playback to ordinary ownership instead of stopping it on later handoff disposal", async () => {
		const value = harness();
		value.handoff.acknowledge(600);
		value.firstStart.resolve();
		await flush();
		expect(value.handoff.active()).toBe(false);
		value.handoff.dispose();
		await flush();
		expect(value.stop).not.toHaveBeenCalled();
	});
});
