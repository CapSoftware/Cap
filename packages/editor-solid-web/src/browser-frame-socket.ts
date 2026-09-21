import { createResource, createSignal } from "solid-js";
import type {
	CanvasControls,
	FrameData,
	ImageDataWSOptions,
} from "../../../apps/desktop/src/utils/socket";
import { BrowserLocalPlayback } from "./browser-local-playback";

export type {
	CanvasControls,
	FrameData,
} from "../../../apps/desktop/src/utils/socket";

class BrowserPreviewSocket extends EventTarget {
	readyState: number = WebSocket.CONNECTING;

	open() {
		if (this.readyState !== WebSocket.CONNECTING) return;
		this.readyState = WebSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}

	close() {
		if (this.readyState === WebSocket.CLOSED) return;
		this.readyState = WebSocket.CLOSED;
		this.dispatchEvent(new Event("close"));
	}
}

type FrameRequest = {
	frame_number: number;
	fps: number;
	resolution_base: { x: number; y: number } | null;
};

function frameRequest(value: unknown): FrameRequest | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const request = value as Record<string, unknown>;
	const base = request.resolution_base;
	let resolution_base: FrameRequest["resolution_base"] = null;
	if (typeof base === "object" && base !== null && !Array.isArray(base)) {
		const size = base as Record<string, unknown>;
		if (
			Number.isSafeInteger(size.x) &&
			Number.isSafeInteger(size.y) &&
			Number(size.x) > 0 &&
			Number(size.y) > 0
		) {
			resolution_base = { x: Number(size.x), y: Number(size.y) };
		}
	}
	if (
		!Number.isSafeInteger(request.frame_number) ||
		Number(request.frame_number) < 0 ||
		!Number.isSafeInteger(request.fps) ||
		Number(request.fps) <= 0
	) {
		return null;
	}
	return {
		frame_number: Number(request.frame_number),
		fps: Number(request.fps),
		resolution_base,
	};
}

class BrowserPreviewController {
	readonly socket = new BrowserPreviewSocket();
	private playback: BrowserLocalPlayback | null = null;
	private creating: Promise<BrowserLocalPlayback> | null = null;
	private disposed = false;
	private desiredTime = 0;
	private desiredPlaying = false;
	private desiredConfig: unknown = null;
	private previewBase = { x: 1248, y: 702 };
	private sizeObserver: ResizeObserver | null = null;
	private sizeAnimationFrame = 0;
	private readonly updateVisibleSize = () => {
		const playback = this.playback;
		if (!playback || this.disposed) return;
		const changed = playback.resizeForBase(
			this.previewBase.x,
			this.previewBase.y,
		);
		if (changed && !this.desiredPlaying) {
			void playback.seek(this.desiredTime).catch((error: unknown) => {
				if (!this.disposed) {
					this.socket.dispatchEvent(new ErrorEvent("error", { error }));
				}
			});
		}
	};
	private readonly scheduleVisibleSize = () => {
		if (this.sizeAnimationFrame !== 0 || this.disposed) return;
		this.sizeAnimationFrame = requestAnimationFrame(() => {
			this.sizeAnimationFrame = 0;
			this.updateVisibleSize();
		});
	};
	private readonly connected: () => boolean;
	private readonly setConnected: (value: boolean) => void;
	private readonly ready: () => boolean;
	private readonly setReady: (value: boolean) => void;
	private readonly rendered: () => boolean;
	private readonly setRendered: (value: boolean) => void;

	constructor(
		private readonly videoId: string,
		private readonly onFrame: (frame: FrameData) => void,
		private readonly onRequestFrame?: () => void,
	) {
		[this.connected, this.setConnected] = createSignal(false);
		[this.ready, this.setReady] = createSignal(false);
		[this.rendered, this.setRendered] = createSignal(false);
		this.socket.addEventListener("close", () => this.dispose());
	}

	isConnected = () => this.connected();
	isReady = () => this.ready();

	seedState(config: unknown, frame: FrameRequest | null, playing: boolean) {
		this.desiredConfig = config;
		this.desiredPlaying = playing;
		if (frame) {
			this.desiredTime = frame.frame_number / frame.fps;
			if (frame.resolution_base) this.previewBase = frame.resolution_base;
		}
	}

	initDirectCanvas(canvas: HTMLCanvasElement) {
		if (this.disposed) throw new Error("Editor local preview is closed");
		if (this.creating || this.playback) return;
		if (typeof ResizeObserver !== "undefined") {
			this.sizeObserver = new ResizeObserver(this.scheduleVisibleSize);
			this.sizeObserver.observe(canvas);
		}
		window.addEventListener("resize", this.scheduleVisibleSize);
		const creating = BrowserLocalPlayback.create(
			this.videoId,
			canvas,
			0,
			0,
			(frame) => {
				if (this.disposed) return;
				this.setRendered(true);
				this.onFrame(frame);
			},
			(error) => {
				if (!this.disposed) {
					this.socket.dispatchEvent(new ErrorEvent("error", { error }));
				}
			},
		);
		this.creating = creating;
		void creating
			.then(async (playback) => {
				if (this.disposed) {
					playback.dispose();
					return;
				}
				this.playback = playback;
				if (this.desiredConfig !== null) {
					await playback.setConfig(this.desiredConfig);
				}
				const resized = playback.resizeForBase(
					this.previewBase.x,
					this.previewBase.y,
				);
				if (this.desiredTime !== 0 || resized) {
					await playback.seek(this.desiredTime);
				}
				if (this.desiredPlaying) playback.play();
				this.setConnected(true);
				this.setReady(true);
				this.socket.open();
				this.onRequestFrame?.();
			})
			.catch((error: unknown) => {
				if (this.disposed) return;
				this.socket.dispatchEvent(new ErrorEvent("error", { error }));
				this.dispose();
			});
	}

	resize(width: number, height: number) {
		this.playback?.resize(width, height);
	}

	async render(value: unknown) {
		const request = frameRequest(value);
		if (!request) throw new Error("Editor frame request is invalid");
		this.desiredTime = request.frame_number / request.fps;
		if (request.resolution_base) this.previewBase = request.resolution_base;
		if (!this.playback) {
			if (this.creating) await this.creating;
			return;
		}
		if (request.resolution_base) {
			this.playback.resizeForBase(
				request.resolution_base.x,
				request.resolution_base.y,
			);
		}
		await this.playback.seek(this.desiredTime);
	}

	async seek(frameNumber: number, fps = 60) {
		if (!Number.isSafeInteger(frameNumber) || frameNumber < 0) {
			throw new Error("Editor seek frame is invalid");
		}
		this.desiredTime = frameNumber / fps;
		if (!this.playback) {
			if (this.creating) await this.creating;
			return;
		}
		await this.playback.seek(this.desiredTime);
	}

	play() {
		this.desiredPlaying = true;
		this.playback?.play();
	}

	pause() {
		this.desiredPlaying = false;
		this.playback?.pause();
	}

	async setConfig(config: unknown) {
		this.desiredConfig = config;
		if (this.playback) {
			await this.playback.setConfig(config);
		}
	}

	hasRenderedFrame() {
		return (
			this.ready() &&
			this.rendered() &&
			this.playback?.hasRenderedFrame() === true
		);
	}

	resetFrameState() {
		this.setRendered(false);
		this.playback?.resetFrameState();
	}

	async captureFrame() {
		return this.playback?.captureFrame() ?? null;
	}

	drawLatestFrameToCanvas(target: HTMLCanvasElement) {
		return this.playback?.drawLatestFrameToCanvas(target) ?? false;
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.playback?.dispose();
		this.playback = null;
		this.sizeObserver?.disconnect();
		this.sizeObserver = null;
		window.removeEventListener("resize", this.scheduleVisibleSize);
		if (this.sizeAnimationFrame !== 0) {
			cancelAnimationFrame(this.sizeAnimationFrame);
			this.sizeAnimationFrame = 0;
		}
		this.setConnected(false);
		this.setReady(false);
		this.setRendered(false);
		if (active === this) active = null;
		this.socket.close();
	}
}

let videoId: string | null = null;
let active: BrowserPreviewController | null = null;
let pendingConfig: unknown = null;
let pendingFrame: FrameRequest | null = null;
let pendingPlaying = false;

export function setBrowserEditorVideoId(value: string | null) {
	if (value !== null && (value.length < 1 || value.length > 255)) {
		throw new Error("Editor video id is invalid");
	}
	if (value !== videoId) {
		active?.dispose();
		pendingConfig = null;
		pendingFrame = null;
		pendingPlaying = false;
	}
	videoId = value;
}

export function browserEditorPreviewEnabled() {
	return videoId !== null;
}

export function playBrowserEditorPreview() {
	pendingPlaying = true;
	active?.play();
}

export function pauseBrowserEditorPreview() {
	pendingPlaying = false;
	active?.pause();
}

export function seekBrowserEditorPreview(frameNumber: number) {
	if (!Number.isSafeInteger(frameNumber) || frameNumber < 0) {
		return Promise.reject(new Error("Editor seek frame is invalid"));
	}
	pendingFrame = {
		frame_number: frameNumber,
		fps: 60,
		resolution_base: pendingFrame?.resolution_base ?? null,
	};
	return active?.seek(frameNumber) ?? Promise.resolve();
}

export function renderBrowserEditorPreview(value: unknown) {
	const request = frameRequest(value);
	if (!request) {
		return Promise.reject(new Error("Editor frame request is invalid"));
	}
	pendingFrame = request;
	return active?.render(request) ?? Promise.resolve();
}

export function setBrowserEditorPreviewConfig(config: unknown) {
	pendingConfig = config;
	return active?.setConfig(config) ?? Promise.resolve();
}

export function createImageDataWS(
	_url: string,
	onmessage: (data: FrameData) => void,
	onRequestFrame?: () => void,
	_options: ImageDataWSOptions = {},
): [
	Omit<WebSocket, "onmessage">,
	() => boolean,
	() => boolean,
	CanvasControls,
] {
	if (!videoId) throw new Error("Editor local preview video is unavailable");
	active?.dispose();
	const controller = new BrowserPreviewController(
		videoId,
		onmessage,
		onRequestFrame,
	);
	controller.seedState(pendingConfig, pendingFrame, pendingPlaying);
	active = controller;
	const controls: CanvasControls = {
		initCanvas: () => {
			throw new Error("Editor local preview requires a visible canvas");
		},
		resizeCanvas: (width, height) => controller.resize(width, height),
		hasRenderedFrame: () => controller.hasRenderedFrame(),
		initDirectCanvas: (canvas) => controller.initDirectCanvas(canvas),
		resetFrameState: () => controller.resetFrameState(),
		captureFrame: () => controller.captureFrame(),
		drawLatestFrameToCanvas: (canvas) =>
			controller.drawLatestFrameToCanvas(canvas),
		dispose: () => controller.dispose(),
	};
	return [
		controller.socket as unknown as Omit<WebSocket, "onmessage">,
		controller.isConnected,
		controller.isReady,
		controls,
	];
}

export function createLazySignal<T>() {
	let resolve: ((value: T) => void) | undefined;
	const [value, { mutate: setValue }] = createResource(
		() =>
			new Promise<T>((next) => {
				resolve = next;
			}),
	);
	return [
		value,
		(next: T) => {
			if (resolve) {
				resolve(next);
				resolve = undefined;
			} else {
				setValue(() => next);
			}
		},
	] as const;
}
