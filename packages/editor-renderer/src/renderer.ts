import type { RenderSpec } from "@cap/editor-render-spec";
import { drawBackground } from "./draw-background";
import { clipMask } from "./draw-mask";
import { drawShadow } from "./draw-shadow";
import { ImageCache } from "./image-cache";
import type { RendererOptions, RendererState } from "./types";

export class EditorRenderer {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private imageCache: ImageCache;
	private resolveBackgroundPath: (path: string) => string;
	private state: RendererState;
	private destroyed = false;

	constructor(options: RendererOptions) {
		this.canvas = options.canvas;
		const ctx = this.canvas.getContext("2d");
		if (!ctx) throw new Error("Failed to get 2D rendering context");
		this.ctx = ctx;

		this.imageCache = new ImageCache();
		this.resolveBackgroundPath = options.resolveBackgroundPath;

		this.state = {
			spec: options.spec,
			video: null,
			scaleFactor: 1,
			displayWidth: options.spec.outputWidth,
			displayHeight: options.spec.outputHeight,
		};

		this.preloadBackgroundImage();
	}

	updateSpec(spec: RenderSpec): void {
		this.state = { ...this.state, spec };
		this.preloadBackgroundImage();
	}

	setVideoSource(video: HTMLVideoElement): void {
		this.state = { ...this.state, video };
	}

	resize(containerWidth: number, containerHeight: number): void {
		const { outputWidth, outputHeight } = this.state.spec;
		const aspectRatio = outputWidth / outputHeight;

		let displayWidth: number;
		let displayHeight: number;

		if (containerWidth / containerHeight > aspectRatio) {
			displayHeight = containerHeight;
			displayWidth = displayHeight * aspectRatio;
		} else {
			displayWidth = containerWidth;
			displayHeight = displayWidth / aspectRatio;
		}

		displayWidth = Math.round(displayWidth);
		displayHeight = Math.round(displayHeight);

		const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
		this.canvas.width = displayWidth * dpr;
		this.canvas.height = displayHeight * dpr;
		this.canvas.style.width = `${displayWidth}px`;
		this.canvas.style.height = `${displayHeight}px`;

		this.state = {
			...this.state,
			scaleFactor: (displayWidth * dpr) / outputWidth,
			displayWidth,
			displayHeight,
		};
	}

	render(): void {
		if (this.destroyed) return;

		const { ctx } = this;
		const { spec, video, scaleFactor } = this.state;

		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

		ctx.save();
		ctx.setTransform(scaleFactor, 0, 0, scaleFactor, 0, 0);

		drawBackground(ctx, spec, this.imageCache, this.resolveBackgroundPath);

		drawShadow(ctx, spec.innerRect, spec.maskSpec, spec.shadowSpec);

		ctx.save();
		clipMask(ctx, spec.innerRect, spec.maskSpec);

		if (video && video.readyState >= 2) {
			const { x, y, width, height } = spec.innerRect;
			const videoRatio = video.videoWidth / video.videoHeight;
			const rectRatio = width / height;

			let drawW: number;
			let drawH: number;
			let drawX: number;
			let drawY: number;

			if (videoRatio > rectRatio) {
				drawW = width;
				drawH = width / videoRatio;
				drawX = x;
				drawY = y + (height - drawH) / 2;
			} else {
				drawH = height;
				drawW = height * videoRatio;
				drawX = x + (width - drawW) / 2;
				drawY = y;
			}

			ctx.drawImage(video, drawX, drawY, drawW, drawH);
		}

		ctx.restore();
		ctx.restore();
	}

	destroy(): void {
		this.destroyed = true;
		this.imageCache.clear();
	}

	private preloadBackgroundImage(): void {
		const bg = this.state.spec.backgroundSpec;
		if ((bg.type === "image" || bg.type === "wallpaper") && bg.path) {
			const resolved = this.resolveBackgroundPath(bg.path);
			this.imageCache.preload(resolved, () => {
				if (!this.destroyed) this.render();
			});
		}
	}
}
