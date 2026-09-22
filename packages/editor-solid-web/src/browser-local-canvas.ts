import type { BrowserGpuRenderer } from "../renderer/pkg/cap_editor_browser_renderer.js";
import { browserWebGpuPresentationWorks } from "./browser-gpu-probe";
import { loadBrowserRenderer } from "./browser-renderer";
import { resolveEditorAssetUrl } from "./editor-asset-url";
import { restoreRawJpegOrientation } from "./editor-background-orientation";

export type BrowserVideoLayer = {
	video: HTMLVideoElement;
	uniforms: Uint8Array;
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
			this.canvas.width = width;
			this.canvas.height = height;
			this.renderer?.resize(width, height);
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
		const blob = await response.blob();
		if (blob.size < 1 || blob.size > 64 * 1024 * 1024) {
			throw new Error("Editor background image is invalid");
		}
		let bitmap = await createImageBitmap(blob);
		if (
			bitmap.width < 1 ||
			bitmap.height < 1 ||
			bitmap.width * bitmap.height > 16_777_216
		) {
			bitmap.close();
			throw new Error("Editor background image is too large");
		}
		if (bitmap.width > 2560 || bitmap.height > 2560) {
			const scale = 2560 / Math.max(bitmap.width, bitmap.height);
			try {
				const resized = await createImageBitmap(bitmap, {
					resizeWidth: Math.max(1, Math.round(bitmap.width * scale)),
					resizeHeight: Math.max(1, Math.round(bitmap.height * scale)),
					resizeQuality: "high",
				});
				bitmap.close();
				bitmap = resized;
			} catch (error) {
				bitmap.close();
				throw error;
			}
		}
		try {
			bitmap = await restoreRawJpegOrientation(bitmap, blob);
		} catch (error) {
			bitmap.close();
			throw error;
		}
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
		if (this.disposed || !this.renderer) {
			throw new Error("Editor canvas is closed");
		}
		this.renderer.set_frame_time(frameNumber, 60);
		if (composition.kind === "single") {
			this.renderer.render(
				composition.screen.video,
				composition.screen.uniforms,
				composition.camera?.video ?? null,
				composition.camera?.uniforms ?? null,
			);
		} else {
			this.renderer.render_transition(
				composition.outgoing.screen.video,
				composition.outgoing.screen.uniforms,
				composition.outgoing.camera?.video ?? null,
				composition.outgoing.camera?.uniforms ?? null,
				composition.incoming.screen.video,
				composition.incoming.screen.uniforms,
				composition.incoming.camera?.video ?? null,
				composition.incoming.camera?.uniforms ?? null,
				composition.type === "cross-fade" ? 0 : 1,
				composition.progress,
			);
		}
		this.rendered = true;
		this.onFrame({
			width: this.width,
			height: this.height,
			renderedFrame: { frameNumber, targetTimeNs },
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
		for (const image of this.imageCache.values()) image.close();
		this.imageCache.clear();
		this.rejectMount?.(new Error("Editor canvas is closed"));
		this.resolveMount = null;
		this.rejectMount = null;
		this.renderer?.free();
		this.renderer = null;
		this.canvas = null;
		this.rendered = false;
	}
}
