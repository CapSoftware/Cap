import type { BrowserStudioRenderer } from "../renderer/pkg/cap_editor_browser_renderer.js";
import { browserFrameLayout } from "./browser-frame-layout";
import { browserWebGpuPresentationWorks } from "./browser-gpu-probe";
import { BrowserImageDecoder } from "./browser-image-decoder";
import { loadBrowserRenderer } from "./browser-renderer";
import { ensureBrowserRendererFonts } from "./browser-renderer-fonts";
import { resolveEditorAssetUrl } from "./editor-asset-url";

export type BrowserVideoLayer = {
	source: HTMLVideoElement | ImageBitmap;
	colorFix: boolean;
	mediaTime: number;
	release: () => void;
};

export type BrowserClipFrame = {
	recordingClip: number;
	segmentTime: number;
	screen: BrowserVideoLayer;
	camera: BrowserVideoLayer | null;
};

export type BrowserComposition =
	| { kind: "single"; frame: BrowserClipFrame }
	| {
			kind: "transition";
			outgoing: BrowserClipFrame;
			incoming: BrowserClipFrame;
			type: "cross-fade" | "fade-through-black";
			progress: number;
	  };

export type BrowserRenderedFrame = {
	width: number;
	height: number;
	renderedFrame: { frameNumber: number; targetTimeNs: bigint };
	layout: ReturnType<typeof browserFrameLayout>;
};

export type BrowserStudioSetup = {
	recordingMeta: unknown;
	screenWidth: number;
	screenHeight: number;
	cameraWidth: number;
	cameraHeight: number;
	cursors: Array<string | null>;
};

type OverlayImageSegment = {
	path: string;
	start: number;
	end: number;
	enabled: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function backgroundImagePath(config: unknown) {
	const source = record(record(record(config)?.background)?.source);
	if (
		!source ||
		(source.type !== "image" && source.type !== "wallpaper") ||
		typeof source.path !== "string"
	) {
		return null;
	}
	return source.path || null;
}

function overlayImageSegments(config: unknown): OverlayImageSegment[] {
	const segments = record(record(config)?.timeline)?.imageSegments;
	if (!Array.isArray(segments)) return [];
	return segments.flatMap((value: unknown) => {
		const segment = record(value);
		if (
			!segment ||
			typeof segment.path !== "string" ||
			!segment.path ||
			typeof segment.start !== "number" ||
			typeof segment.end !== "number" ||
			!Number.isFinite(segment.start) ||
			!Number.isFinite(segment.end) ||
			segment.end <= segment.start
		) {
			return [];
		}
		return [
			{
				path: segment.path,
				start: segment.start,
				end: segment.end,
				enabled: segment.enabled !== false,
			},
		];
	});
}

type TimedSegment = { start: number; end: number };

function timedSegments(value: unknown): TimedSegment[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry: unknown) => {
		const segment = record(entry);
		return segment &&
			typeof segment.start === "number" &&
			typeof segment.end === "number"
			? [{ start: segment.start, end: segment.end }]
			: [];
	});
}

/// Time ranges that draw text (text and title cards, captions, keystrokes).
function textRanges(config: unknown): TimedSegment[] {
	const project = record(config);
	const timeline = record(project?.timeline);
	return [
		...timedSegments(timeline?.textSegments),
		...timedSegments(timeline?.captionSegments),
		...timedSegments(timeline?.keyboardSegments),
		...timedSegments(record(project?.captions)?.segments),
	];
}

export class BrowserLocalCanvas {
	private canvas: HTMLCanvasElement | null = null;
	private renderer: BrowserStudioRenderer | null = null;
	private readonly mounted: Promise<void>;
	private resolveMount: (() => void) | null = null;
	private rejectMount: ((error: Error) => void) | null = null;
	private rendered = false;
	private disposed = false;
	private configQueue: Promise<void> = Promise.resolve();
	private readonly imageAbort = new AbortController();
	private readonly loadedAssets = new Map<string, Promise<void>>();
	private overlaySegments: OverlayImageSegment[] = [];
	private imageDecoder: BrowserImageDecoder | null = null;
	private textRanges: TimedSegment[] = [];
	private fonts: Promise<void> | null = null;
	private fontsReady = false;
	private lastSize = { width: 0, height: 0 };

	constructor(
		private readonly setup: BrowserStudioSetup,
		private width: number,
		private height: number,
		private readonly onFrame: (frame: BrowserRenderedFrame) => void,
		private readonly onInvalidate: () => void = () => undefined,
	) {
		this.mounted = new Promise((resolve, reject) => {
			this.resolveMount = resolve;
			this.rejectMount = reject;
		});
		this.mounted.catch(() => undefined);
	}

	initDirectCanvas(canvas: HTMLCanvasElement) {
		if (this.disposed) throw new Error("Editor canvas is closed");
		if (this.canvas) {
			if (this.canvas === canvas) return;
			throw new Error("Editor canvas is already mounted");
		}
		this.canvas = canvas;
		canvas.width = this.width;
		canvas.height = this.height;
		void Promise.all([loadBrowserRenderer(), browserWebGpuPresentationWorks()])
			.then(([module, webgpuReady]) =>
				module.BrowserStudioRenderer.create(
					canvas,
					webgpuReady,
					JSON.stringify(this.setup.recordingMeta),
					this.setup.screenWidth,
					this.setup.screenHeight,
					this.setup.cameraWidth,
					this.setup.cameraHeight,
				),
			)
			.then((renderer) => {
				if (this.disposed) {
					renderer.free();
					return;
				}
				this.setup.cursors.forEach((cursor, index) => {
					if (cursor) renderer.set_cursor(index, cursor);
				});
				this.renderer = renderer;
				this.resolveMount?.();
				this.resolveMount = null;
				this.rejectMount = null;
			})
			.catch((error: unknown) => {
				this.rejectMount?.(
					error instanceof Error ? error : new Error(String(error)),
				);
				this.resolveMount = null;
				this.rejectMount = null;
			});
	}

	initCanvas(_canvas: OffscreenCanvas) {
		throw new Error("Editor preview needs a visible canvas");
	}

	resizeCanvas(width: number, height: number) {
		if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
			throw new Error("Editor canvas size is invalid");
		}
		if (width < 2 || height < 2) {
			throw new Error("Editor canvas size is invalid");
		}
		this.width = width;
		this.height = height;
		if (this.canvas) this.rendered = false;
	}

	hasRenderedFrame() {
		return this.rendered;
	}

	resetFrameState() {
		this.rendered = false;
	}

	/// Output size of the next frame for a preview box, per the native renderer.
	async outputSize(width: number, height: number) {
		await this.mounted;
		await this.configQueue;
		if (this.disposed || !this.renderer) {
			throw new Error("Editor canvas is closed");
		}
		const size = this.renderer.output_size(width, height);
		return [size[0] ?? width, size[1] ?? height] as const;
	}

	private decoder() {
		if (!this.imageDecoder) this.imageDecoder = new BrowserImageDecoder();
		return this.imageDecoder;
	}

	private loadImageAsset(path: string) {
		const existing = this.loadedAssets.get(path);
		if (existing) return existing;
		const load = (async () => {
			const module = await loadBrowserRenderer();
			if (module.has_asset(path)) return;
			const url = resolveEditorAssetUrl(path);
			if (!url) throw new Error("Editor image is unavailable");
			const response = await fetch(url, {
				cache: "default",
				credentials: "same-origin",
				signal: this.imageAbort.signal,
			});
			if (!response.ok) throw new Error("Editor image could not load");
			const bytes = await response.arrayBuffer();
			if (bytes.byteLength < 1 || bytes.byteLength > 64 * 1024 * 1024) {
				throw new Error("Editor image is invalid");
			}
			const image = await this.decoder().decode(bytes);
			if (this.disposed) throw new Error("Editor canvas is closed");
			module.register_decoded_asset(
				path,
				image.width,
				image.height,
				new Uint8Array(image.pixels),
			);
		})();
		this.loadedAssets.set(path, load);
		load.catch(() => {
			if (this.loadedAssets.get(path) === load) this.loadedAssets.delete(path);
		});
		return load;
	}

	/// Fonts download in the background; frames without visible text render
	/// immediately and the preview redraws once the faces are registered.
	private loadFonts() {
		if (this.fonts) return this.fonts;
		const fonts = ensureBrowserRendererFonts().then(() => {
			if (this.disposed) return;
			this.fontsReady = true;
			this.rendered = false;
			this.onInvalidate();
		});
		this.fonts = fonts;
		fonts.catch(() => {
			if (this.fonts === fonts) this.fonts = null;
		});
		return fonts;
	}

	private async ensureFonts(time: number) {
		if (this.fontsReady) return;
		if (
			!this.textRanges.some(
				(range) => time >= range.start - 0.1 && time < range.end,
			)
		)
			return;
		await this.loadFonts().catch(() => undefined);
	}

	private async ensureOverlayImages(time: number) {
		const active = this.overlaySegments.filter(
			(segment) =>
				segment.enabled && time >= segment.start - 1 && time < segment.end,
		);
		await Promise.all(
			active.map((segment) => this.loadImageAsset(segment.path)),
		);
	}

	setProjectConfig(config: unknown) {
		const update = this.configQueue.then(async () => {
			await this.mounted;
			if (this.disposed || !this.renderer) {
				throw new Error("Editor canvas is closed");
			}
			const path = backgroundImagePath(config);
			if (path) await this.loadImageAsset(path);
			this.textRanges = textRanges(config);
			if (this.textRanges.length > 0 && this.rendered) void this.loadFonts();
			if (this.disposed || !this.renderer) {
				throw new Error("Editor canvas is closed");
			}
			this.overlaySegments = overlayImageSegments(config);
			this.renderer.set_project(JSON.stringify(config));
			this.rendered = false;
		});
		this.configQueue = update.catch(() => undefined);
		return update;
	}

	async render(
		composition: BrowserComposition,
		frameNumber: number,
		targetTimeNs: bigint,
	) {
		await this.mounted;
		await this.configQueue;
		if (this.disposed || !this.renderer) {
			throw new Error("Editor canvas is closed");
		}
		await Promise.all([
			this.ensureOverlayImages(frameNumber / 60),
			this.ensureFonts(frameNumber / 60),
		]);
		const renderer = this.renderer;
		if (this.disposed || !renderer) {
			throw new Error("Editor canvas is closed");
		}
		const layout =
			composition.kind === "single"
				? renderer.render(
						frameNumber,
						60,
						this.width,
						this.height,
						composition.frame.recordingClip,
						composition.frame.segmentTime,
						composition.frame.screen.source,
						composition.frame.screen.colorFix,
						composition.frame.camera?.source ?? null,
						composition.frame.camera?.colorFix ?? false,
					)
				: renderer.render_transition(
						frameNumber,
						60,
						this.width,
						this.height,
						composition.outgoing.recordingClip,
						composition.outgoing.segmentTime,
						composition.outgoing.screen.source,
						composition.outgoing.screen.colorFix,
						composition.outgoing.camera?.source ?? null,
						composition.outgoing.camera?.colorFix ?? false,
						composition.incoming.recordingClip,
						composition.incoming.segmentTime,
						composition.incoming.screen.source,
						composition.incoming.screen.colorFix,
						composition.incoming.camera?.source ?? null,
						composition.incoming.camera?.colorFix ?? false,
						composition.type === "cross-fade" ? 0 : 1,
						composition.progress,
					);
		const frameLayout = browserFrameLayout(layout);
		this.lastSize = {
			width: frameLayout.output_width,
			height: frameLayout.output_height,
		};
		this.rendered = true;
		if (this.textRanges.length > 0 && !this.fontsReady) {
			void this.loadFonts().catch(() => undefined);
		}
		this.onFrame({
			width: frameLayout.output_width,
			height: frameLayout.output_height,
			renderedFrame: { frameNumber, targetTimeNs },
			layout: frameLayout,
		});
	}

	captureFrame(): Promise<Blob | null> {
		const canvas = this.canvas;
		if (!this.rendered || !canvas || !this.renderer) {
			return Promise.resolve(null);
		}
		if (!this.renderer.redraw_last()) return Promise.resolve(null);
		return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
	}

	drawLatestFrameToCanvas(target: HTMLCanvasElement) {
		if (!this.rendered || !this.canvas || !this.renderer) return false;
		if (!this.renderer.redraw_last()) return false;
		const { width, height } = this.lastSize;
		if (width < 1 || height < 1) return false;
		target.width = width;
		target.height = height;
		const context = target.getContext("2d");
		if (!context) return false;
		context.drawImage(this.canvas, 0, 0, width, height);
		return true;
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.imageAbort.abort();
		this.imageDecoder?.dispose();
		this.imageDecoder = null;
		this.loadedAssets.clear();
		this.overlaySegments = [];
		this.rejectMount?.(new Error("Editor canvas is closed"));
		this.resolveMount = null;
		this.rejectMount = null;
		this.renderer?.free();
		this.renderer = null;
		this.canvas = null;
		this.rendered = false;
	}
}
