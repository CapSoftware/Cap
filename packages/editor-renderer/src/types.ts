import type { RenderSpec } from "@cap/editor-render-spec";

export type RendererOptions = {
	canvas: HTMLCanvasElement;
	spec: RenderSpec;
	resolveBackgroundPath: (path: string) => string;
};

export type RendererState = {
	spec: RenderSpec;
	video: HTMLVideoElement | null;
	camera: HTMLVideoElement | null;
	displayWidth: number;
	displayHeight: number;
};
