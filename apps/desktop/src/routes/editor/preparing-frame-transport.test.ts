import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreparingFrameLease } from "~/routes/editor/preparing-frame-lease";
import { createImageDataWS } from "~/utils/socket";
import { attachPreparingFrameTransport } from "./preparing-frame-transport";

const sockets = vi.hoisted(() => {
	class Socket extends EventTarget {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		static instances: Socket[] = [];
		readyState = Socket.OPEN;
		binaryType = "blob";
		onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
		constructor(readonly url: string) {
			super();
			Socket.instances.push(this);
		}
		close() {
			if (this.readyState === Socket.CLOSED) return;
			this.readyState = Socket.CLOSED;
			this.dispatchEvent(new Event("close"));
		}
		fail() {
			this.dispatchEvent(new Event("error"));
		}
		frame(bytes: ArrayBuffer) {
			this.onmessage?.({ data: bytes });
		}
	}
	return { Socket };
});

vi.mock("@solid-primitives/websocket", () => ({
	createWS: (url: string) => new sockets.Socket(url),
}));
vi.mock("~/utils/frame-worker?worker", () => ({
	default: class {
		constructor() {
			throw new Error(
				"The first-frame direct canvas must not allocate a worker",
			);
		}
	},
}));
vi.mock("~/utils/stride-correction-worker?worker", () => ({
	default: class {
		constructor() {
			throw new Error(
				"The tightly packed native test frame needs no stride worker",
			);
		}
	},
}));

class Pixels {
	readonly data: Uint8ClampedArray;
	constructor(
		readonly width: number,
		readonly height: number,
	) {
		this.data = new Uint8ClampedArray(width * height * 4);
	}
}

class Canvas {
	width = 0;
	height = 0;
	isConnected = true;
	pixels: number[] = [];
	getContext() {
		return {
			putImageData: (image: Pixels) => {
				this.pixels = Array.from(image.data);
			},
		};
	}
	asElement() {
		return this as unknown as HTMLCanvasElement;
	}
}

const rgba = [29, 61, 127, 255];
let scheduled: Map<number, FrameRequestCallback>;
let nextFrame: number;

function packedFrame(pixels = rgba, frameNumber = 0, targetTimeNs = 0n) {
	const buffer = new ArrayBuffer(rgba.length + 24);
	new Uint8Array(buffer).set(pixels);
	const metadata = new DataView(buffer, rgba.length, 24);
	metadata.setUint32(0, 4, true);
	metadata.setUint32(4, 1, true);
	metadata.setUint32(8, 1, true);
	metadata.setUint32(12, frameNumber, true);
	metadata.setBigUint64(16, targetTimeNs, true);
	return buffer;
}

function renderScheduledFrame() {
	const callbacks = Array.from(scheduled.values());
	scheduled.clear();
	for (const callback of callbacks) callback(performance.now());
}

async function mount() {
	const canvas = new Canvas();
	const retainedCanvas = new Canvas();
	const rendered = vi.fn();
	const frame = vi.fn();
	const ended = vi.fn();
	const stop = vi.fn(async (_epoch: number) => {});
	const lease = createPreparingFrameLease({
		start: async () => "ws://127.0.0.1/owned",
		stop,
		ended,
		attach: (url, isActive) =>
			attachPreparingFrameTransport({
				url,
				canvas: canvas.asElement(),
				retainedCanvas: retainedCanvas.asElement(),
				isActive,
				onRendered: rendered,
				onFrame: frame,
				onTerminal: () => lease.finish(),
			}),
	});
	await lease.start();
	const socket = sockets.Socket.instances.at(-1);
	if (!socket)
		throw new Error("Expected the actual socket utility to create a websocket");
	return {
		canvas,
		retainedCanvas,
		rendered,
		frame,
		ended,
		stop,
		lease,
		socket,
	};
}

beforeEach(() => {
	sockets.Socket.instances = [];
	scheduled = new Map();
	nextFrame = 0;
	vi.stubGlobal("WebSocket", sockets.Socket);
	vi.stubGlobal("ImageData", Pixels);
	vi.stubGlobal("navigator", {});
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		const id = ++nextFrame;
		scheduled.set(id, callback);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => scheduled.delete(id));
});

afterEach(() => {
	for (const socket of sockets.Socket.instances) socket.close();
	vi.unstubAllGlobals();
});

describe("preparing transport with the actual socket utility", () => {
	it("demonstrates that a later terminal listener cannot copy the disposed socket frame", () => {
		const canvas = new Canvas();
		const retainedCanvas = new Canvas();
		const [socket, , , controls] = createImageDataWS(
			"ws://old-order",
			() => {},
		);
		controls.initDirectCanvas(canvas.asElement());
		let copied: boolean | undefined;
		socket.addEventListener("close", () => {
			copied = controls.drawLatestFrameToCanvas(retainedCanvas.asElement());
		});
		const source = sockets.Socket.instances[0];
		source.frame(packedFrame());
		renderScheduledFrame();
		expect(canvas.pixels).toEqual(rgba);
		source.close();
		expect(copied).toBe(false);
		expect(retainedCanvas.pixels).toEqual([]);
	});

	it.each(["close", "error"] as const)(
		"retains exact displayed pixels through earlier socket %s cleanup",
		async (event) => {
			const mounted = await mount();
			mounted.socket.frame(packedFrame());
			expect(mounted.rendered).not.toHaveBeenCalled();
			renderScheduledFrame();
			expect(mounted.canvas.pixels).toEqual(rgba);
			expect(mounted.retainedCanvas.pixels).toEqual(rgba);
			expect(mounted.rendered).toHaveBeenLastCalledWith(true);
			if (event === "close") mounted.socket.close();
			else mounted.socket.fail();
			expect(mounted.ended).toHaveBeenCalledWith(true);
			expect(mounted.retainedCanvas.pixels).toEqual(rgba);
			expect(mounted.lease.isActive()).toBe(false);
			expect(mounted.stop).toHaveBeenCalledTimes(1);
			mounted.lease.close();
			expect(mounted.stop).toHaveBeenCalledTimes(1);
		},
	);

	it("acknowledges the exact nonzero RGBA identity only after the scheduled pixels render", async () => {
		const mounted = await mount();
		mounted.socket.frame(packedFrame(rgba, 315, 10_500_000_000n));
		expect(mounted.frame).not.toHaveBeenCalled();
		renderScheduledFrame();
		expect(mounted.frame).toHaveBeenLastCalledWith({
			width: 1,
			height: 1,
			renderedFrame: { frameNumber: 315, targetTimeNs: 10_500_000_000n },
		});
		mounted.lease.close();
	});

	it("carries exact NV12 identity through the actual fallback draw", async () => {
		const mounted = await mount();
		const buffer = new ArrayBuffer(6 + 28);
		new Uint8Array(buffer).set([16, 16, 16, 16, 128, 128]);
		const metadata = new DataView(buffer, 6, 28);
		metadata.setUint32(0, 2, true);
		metadata.setUint32(4, 2, true);
		metadata.setUint32(8, 2, true);
		metadata.setUint32(12, 216000, true);
		metadata.setBigUint64(16, 7_200_000_000_000n, true);
		metadata.setUint32(24, 0x4e563132, true);
		mounted.socket.frame(buffer);
		expect(mounted.frame).not.toHaveBeenCalled();
		renderScheduledFrame();
		expect(mounted.frame).toHaveBeenLastCalledWith({
			width: 2,
			height: 2,
			renderedFrame: { frameNumber: 216000, targetTimeNs: 7_200_000_000_000n },
		});
		expect(mounted.canvas.pixels).toEqual([
			0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
		]);
		mounted.lease.close();
	});

	it("retains the latest displayed frame rather than the first frame when playback ends", async () => {
		const mounted = await mount();
		mounted.socket.frame(packedFrame());
		renderScheduledFrame();
		const later = [200, 151, 80, 255];
		mounted.socket.frame(packedFrame(later));
		renderScheduledFrame();
		expect(mounted.canvas.pixels).toEqual(later);
		expect(mounted.retainedCanvas.pixels).toEqual(rgba);
		mounted.socket.close();
		expect(mounted.retainedCanvas.pixels).toEqual(later);
		expect(mounted.ended).toHaveBeenCalledWith(true);
	});

	it("keeps the ordinary spinner when finalization ends before a queued frame renders", async () => {
		const mounted = await mount();
		mounted.socket.frame(packedFrame());
		expect(scheduled.size).toBe(1);
		mounted.socket.close();
		renderScheduledFrame();
		expect(mounted.rendered).not.toHaveBeenCalled();
		expect(mounted.ended).toHaveBeenCalledWith(false);
		expect(mounted.retainedCanvas.pixels).toEqual([]);
	});

	it("cannot attach old pixels to a new lease after the first skeleton unmounts", async () => {
		const old = await mount();
		old.socket.frame(packedFrame());
		old.lease.close();
		const next = await mount();
		renderScheduledFrame();
		expect(old.rendered).not.toHaveBeenCalled();
		expect(old.retainedCanvas.pixels).toEqual([]);
		expect(next.retainedCanvas.pixels).toEqual([]);
		expect(next.lease.isActive()).toBe(true);
		next.socket.frame(packedFrame());
		renderScheduledFrame();
		expect(next.retainedCanvas.pixels).toEqual(rgba);
		next.lease.close();
	});
});
