import { type RenderSpec, scaleRenderSpec } from "@cap/editor-render-spec";
import { composeFrame } from "./compose-frame";
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
			camera: null,
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

	setCameraSource(camera: HTMLVideoElement): void {
		this.state = { ...this.state, camera };
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
			displayWidth,
			displayHeight,
		};
	}

	render(): void {
		if (this.destroyed) return;

		const { spec, video, camera } = this.state;

		if (!video || video.readyState < 2) return;

		const ctx = this.ctx;

		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

		const displaySpec = scaleRenderSpec(spec, this.canvas.width);

		const videoFrame =
			video && video.readyState >= 2
				? { source: video, width: video.videoWidth, height: video.videoHeight }
				: null;

		const cameraFrame =
			camera && camera.readyState >= 2
				? {
						source: camera,
						width: camera.videoWidth,
						height: camera.videoHeight,
					}
				: null;

		const bg = spec.backgroundSpec;
		let bgImage: unknown = null;
		let bgImageWidth = 0;
		let bgImageHeight = 0;
		if ((bg.type === "image" || bg.type === "wallpaper") && bg.path) {
			const resolved = this.resolveBackgroundPath(bg.path);
			const img = this.imageCache.get(resolved);
			if (img) {
				bgImage = img;
				bgImageWidth = img.naturalWidth;
				bgImageHeight = img.naturalHeight;
			}
		}

		composeFrame(
			ctx,
			displaySpec,
			videoFrame,
			bgImage,
			bgImageWidth,
			bgImageHeight,
			cameraFrame,
		);
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
