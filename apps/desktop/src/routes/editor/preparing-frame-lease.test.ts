import { describe, expect, it, vi } from "vitest";
import { createPreparingFrameLease } from "./preparing-frame-lease";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { resolve, promise };
}

describe("preparing frame lease", () => {
	it("retires late admission after unmount without attaching its socket", async () => {
		const admission = deferred<string | null>();
		const start = vi.fn((_epoch: number) => admission.promise);
		const stop = vi.fn(async (_epoch: number) => {});
		const attach = vi.fn(() => ({ dispose() {} }));
		const lease = createPreparingFrameLease({
			start,
			stop,
			attach,
			ended() {},
		});
		const pending = lease.start();
		lease.close();
		admission.resolve("ws://old");
		await pending;
		expect(attach).not.toHaveBeenCalled();
		expect(stop.mock.calls).toEqual([
			[start.mock.calls[0][0]],
			[start.mock.calls[0][0]],
		]);
	});

	it("keeps old cleanup and late frames scoped when a new skeleton mounts", async () => {
		const epochs: number[] = [];
		const stopped: number[] = [];
		const accepts: Array<() => boolean> = [];
		const dispose = vi.fn();
		const options = {
			start: async (epoch: number) => {
				epochs.push(epoch);
				return "ws://owned";
			},
			stop: async (epoch: number) => {
				stopped.push(epoch);
			},
			attach: (_url: string, isActive: () => boolean) => {
				accepts.push(isActive);
				return { dispose };
			},
			ended() {},
		};
		const old = createPreparingFrameLease(options);
		await old.start();
		old.close();
		const next = createPreparingFrameLease(options);
		await next.start();
		old.close();
		expect(accepts.map((accept) => accept())).toEqual([false, true]);
		expect(stopped).toEqual([epochs[0]]);
		expect(epochs[1]).toBeGreaterThan(epochs[0]);
		expect(dispose).toHaveBeenCalledTimes(1);
		next.close();
	});

	it("disposes a connection whose attach synchronously closes the owner", async () => {
		const dispose = vi.fn();
		const stop = vi.fn(async (_epoch: number) => {});
		const lease = createPreparingFrameLease({
			start: async () => "ws://owned",
			stop,
			attach: () => {
				lease.close();
				return { dispose };
			},
			ended() {},
		});
		await lease.start();
		expect(lease.isActive()).toBe(false);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("decline and command failure keep the existing skeleton and retire once", async () => {
		for (const start of [
			async () => null,
			async () => {
				throw new Error("closed");
			},
		]) {
			const ended = vi.fn();
			const stop = vi.fn(async (_epoch: number) => {});
			const attach = vi.fn(() => ({ dispose() {} }));
			const lease = createPreparingFrameLease({ start, stop, attach, ended });
			await lease.start();
			await lease.start();
			lease.close();
			expect(attach).not.toHaveBeenCalled();
			expect(ended).toHaveBeenCalledTimes(1);
			expect(stop).toHaveBeenCalledTimes(1);
		}
	});
	it("holds a displayed first frame before disposal and keeps the spinner when no frame arrived", async () => {
		for (const frameArrived of [true, false]) {
			const calls: string[] = [];
			const ended = vi.fn();
			const lease = createPreparingFrameLease({
				start: async () => "ws://owned",
				stop: async () => {},
				attach: () => ({
					preserveFrame() {
						calls.push("preserve");
						return frameArrived;
					},
					dispose() {
						calls.push("dispose");
					},
				}),
				ended,
			});
			await lease.start();
			lease.finish();
			expect(calls).toEqual(["preserve", "dispose"]);
			expect(ended).toHaveBeenCalledWith(frameArrived);
			expect(lease.isActive()).toBe(false);
			lease.close();
			expect(ended).toHaveBeenCalledTimes(1);
		}
	});
});
