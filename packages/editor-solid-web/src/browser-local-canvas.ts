import type { BrowserGpuRenderer } from "../renderer/pkg/cap_editor_browser_renderer.js";
import { browserFrameLayout } from "./browser-frame-layout";
import { browserWebGpuPresentationWorks } from "./browser-gpu-probe";
import { BrowserImageDecoder } from "./browser-image-decoder";
import { loadBrowserRenderer } from "./browser-renderer";
import { resolveEditorAssetUrl } from "./editor-asset-url";

export type BrowserVideoLayer = {
	source: HTMLVideoElement | ImageBitmap;
	uniforms: Uint8Array;
	mediaTime: number;
	release: () => void;
};

export type BrowserComposition =
	| {
			kind: "single";
			screen: BrowserVideoLayer;
			camera: BrowserVideoLayer | null;
	  }
	| {
			kind: "transition";
			outgoing: {
				screen: BrowserVideoLayer;
				camera: BrowserVideoLayer | null;
			};
			incoming: {
				screen: BrowserVideoLayer;
				camera: BrowserVideoLayer | null;
			};
			type: "cross-fade" | "fade-through-black";
			progress: number;
	  };

export type BrowserRenderedFrame = {
	width: number;
	height: number;
	renderedFrame: { frameNumber: number; targetTimeNs: bigint };
	layout: ReturnType<typeof browserFrameLayout>;
};

function backgroundImagePath(config: unknown) {
	if (
		typeof config !== "object" ||
		config === null ||
		!("background" in config)
	) {
		return null;
	}
	const background = config.background;
	if (
		typeof background !== "object" ||
		background === null ||
		!("source" in background)
	) {
		return null;
	}
	const source = background.source;
	if (
		typeof source !== "object" ||
		source === null ||
		!("type" in source) ||
		(source.type !== "image" && source.type !== "wallpaper") ||
		!("path" in source) ||
		typeof source.path !== "string"
	) {
		return null;
	}
	return source.path || null;
}

type OverlayImageSegment = {
	path: string;
	start: number;
	end: number;
	enabled: boolean;
};

function overlayImageSegments(config: unknown): OverlayImageSegment[] {
	if (
		typeof config !== "object" ||
		config === null ||
		!("timeline" in config) ||
		typeof config.timeline !== "object" ||
		config.timeline === null ||
		!("imageSegments" in config.timeline) ||
		!Array.isArray(config.timeline.imageSegments)
	) {
		return [];
	}
	return config.timeline.imageSegments.flatMap((segment: unknown) => {
		if (
			typeof segment !== "object" ||
			segment === null ||
			!("path" in segment) ||
			!("start" in segment) ||
			!("end" in segment) ||
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
				enabled: !("enabled" in segment) || segment.enabled !== false,
			},
		];
	});
}

export class BrowserLocalCanvas {
	private canvas: HTMLCanvasElement | null = null;
	private renderer: BrowserGpuRenderer | null = null;
	private readonly mounted: Promise<void>;
	private resolveMount: (() => void) | null = null;
	private rejectMount: ((error: Error) => void) | null = null;
	private rendered = false;
	private disposed = false;
	private configQueue: Promise<void> = Promise.resolve();
	private readonly imageAbort = new AbortController();
	private readonly imageCache = new Map<string, ImageBitmap>();
	private readonly overlayDimensions = new Map<string, number>();
	private overlaySegments: OverlayImageSegment[] = [];
	private overlayRevision = 0;
	private imageDecoder: BrowserImageDecoder | null = null;
	private cameraHidden = false;

	constructor(
		private width: number,
		private height: number,
		private readonly onFrame: (frame: BrowserRenderedFrame) => void,
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
				webgpuReady
					? module.BrowserGpuRenderer.create(canvas)
					: module.BrowserGpuRenderer.createWebGl(canvas),
			)
			.then((renderer) => {
				if (this.disposed) {
					renderer.free();
					return;
				}
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
		if (width < 1 || height < 1) {
			throw new Error("Editor canvas size is invalid");
		}
		this.width = width;
		this.height = height;
		if (this.canvas) {
			this.overlayRevision++;
			this.rendered = false;
		}
	}

	hasRenderedFrame() {
		return this.rendered;
	}

	resetFrameState() {
		this.rendered = false;
	}

	private async backgroundImage(url: string) {
		const cached = this.imageCache.get(url);
		if (cached) {
			this.imageCache.delete(url);
			this.imageCache.set(url, cached);
			return cached;
		}
		const response = await fetch(url, {
			cache: "no-store",
			credentials: "same-origin",
			signal: this.imageAbort.signal,
		});
		if (!response.ok) throw new Error("Editor background image could not load");
		const bytes = await response.arrayBuffer();
		if (bytes.byteLength < 1 || bytes.byteLength > 64 * 1024 * 1024) {
			throw new Error("Editor background image is invalid");
		}
		if (!this.imageDecoder) this.imageDecoder = new BrowserImageDecoder();
		const decoder = this.imageDecoder;
		const image = await decoder.decode(bytes);
		const bitmap = await createImageBitmap(
			new ImageData(
				new Uint8ClampedArray(image.pixels),
				image.width,
				image.height,
			),
			{ premultiplyAlpha: "none", colorSpaceConversion: "none" },
		);
		if (this.disposed) {
			bitmap.close();
			throw new Error("Editor canvas is closed");
		}
		this.imageCache.set(url, bitmap);
		if (this.imageCache.size > 8) {
			const oldest = this.imageCache.keys().next().value;
			if (oldest) {
				this.imageCache.get(oldest)?.close();
				this.imageCache.delete(oldest);
			}
		}
		return bitmap;
	}

	private async ensureOverlayImages(time: number) {
		if (this.overlaySegments.length === 0) return;
		const renderer = this.renderer;
		if (!renderer) throw new Error("Editor canvas is closed");
		const active = new Set(
			this.overlaySegments
				.filter(
					(segment) =>
						segment.enabled && time >= segment.start && time < segment.end,
				)
				.map((segment) => segment.path),
		);
		const memoryDimension = Math.floor(
			Math.sqrt((256 * 1024 * 1024) / Math.max(active.size, 1) / (4 * (4 / 3))),
		);
		const dimension = Math.min(
			4096,
			Math.max(256, Math.min(this.width * 2, this.height * 2, memoryDimension)),
		);
		for (const path of active) {
			if (
				renderer.has_overlay_image(path) &&
				(this.overlayDimensions.get(path) ?? 0) >= dimension
			) {
				continue;
			}
			const url = resolveEditorAssetUrl(path);
			if (!url) throw new Error("Editor image overlay is unavailable");
			const revision = this.overlayRevision;
			const response = await fetch(url, {
				cache: "no-store",
				credentials: "same-origin",
				signal: this.imageAbort.signal,
			});
			if (!response.ok) throw new Error("Editor image overlay could not load");
			const bytes = await response.arrayBuffer();
			if (bytes.byteLength < 1 || bytes.byteLength > 64 * 1024 * 1024) {
				throw new Error("Editor image overlay is invalid");
			}
			if (!this.imageDecoder) this.imageDecoder = new BrowserImageDecoder();
			const image = await this.imageDecoder.decodeOverlay(bytes, dimension);
			if (this.disposed || !this.renderer)
				throw new Error("Editor canvas is closed");
			if (
				revision !== this.overlayRevision ||
				!this.overlaySegments.some((segment) => segment.path === path)
			) {
				continue;
			}
			const first = image.levels[0];
			if (!first) throw new Error("Editor image overlay is invalid");
			this.renderer.set_overlay_image(
				path,
				first.width,
				first.height,
				image.levels.map((level) => new Uint8Array(level.pixels)),
			);
			this.overlayDimensions.set(path, dimension);
		}
	}

	setProjectConfig(config: unknown) {
		const update = this.configQueue.then(async () => {
			await this.mounted;
			if (this.disposed || !this.renderer) {
				throw new Error("Editor canvas is closed");
			}
			const path = backgroundImagePath(config);
			const url = path ? resolveEditorAssetUrl(path) : null;
			if (path && !url)
				throw new Error("Editor background image is unavailable");
			const image = url ? await this.backgroundImage(url) : undefined;
			if (this.disposed || !this.renderer) {
				throw new Error("Editor canvas is closed");
			}
			this.renderer.set_background(JSON.stringify(config), image);
			this.cameraHidden =
				typeof config === "object" &&
				config !== null &&
				"camera" in config &&
				typeof config.camera === "object" &&
				config.camera !== null &&
				"hide" in config.camera &&
				config.camera.hide === true;
			this.overlaySegments = overlayImageSegments(config);
			this.overlayRevision++;
			const referenced = new Set(
				this.overlaySegments.map((segment) => segment.path),
			);
			for (const path of this.overlayDimensions.keys()) {
				if (!referenced.has(path)) this.overlayDimensions.delete(path);
			}
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
		this.renderer.set_frame_time(frameNumber, 60);
		await this.ensureOverlayImages(frameNumber / 60);
		if (this.disposed || !this.renderer) {
			throw new Error("Editor canvas is closed");
		}
		if (
			this.canvas &&
			(this.canvas.width !== this.width || this.canvas.height !== this.height)
		) {
			this.canvas.width = this.width;
			this.canvas.height = this.height;
			this.renderer.resize(this.width, this.height);
		}
		if (composition.kind === "single") {
			this.renderer.render(
				composition.screen.source,
				composition.screen.uniforms,
				composition.camera?.source ?? null,
				composition.camera?.uniforms ?? null,
			);
		} else {
			this.renderer.render_transition(
				composition.outgoing.screen.source,
				composition.outgoing.screen.uniforms,
				composition.outgoing.camera?.source ?? null,
				composition.outgoing.camera?.uniforms ?? null,
				composition.incoming.screen.source,
				composition.incoming.screen.uniforms,
				composition.incoming.camera?.source ?? null,
				composition.incoming.camera?.uniforms ?? null,
				composition.type === "cross-fade" ? 0 : 1,
				composition.progress,
			);
		}
		this.rendered = true;
		const frame =
			composition.kind === "single" ? composition : composition.incoming;
		this.onFrame({
			width: this.width,
			height: this.height,
			renderedFrame: { frameNumber, targetTimeNs },
			layout: browserFrameLayout(
				frame.screen.uniforms,
				this.cameraHidden ? null : (frame.camera?.uniforms ?? null),
				this.width,
				this.height,
			),
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
		target.width = this.width;
		target.height = this.height;
		const context = target.getContext("2d");
		if (!context) return false;
		context.drawImage(this.canvas, 0, 0, this.width, this.height);
		return true;
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.imageAbort.abort();
		this.imageDecoder?.dispose();
		this.imageDecoder = null;
		for (const image of this.imageCache.values()) image.close();
		this.imageCache.clear();
		this.overlayDimensions.clear();
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
