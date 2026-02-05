import type { RenderSpec } from "@cap/editor-render-spec";

export type RendererOptions = {
	canvas: HTMLCanvasElement;
	spec: RenderSpec;
	resolveBackgroundPath: (path: string) => string;
};

export type RendererState = {
	spec: RenderSpec;
	video: HTMLVideoElement | null;
	scaleFactor: number;
	displayWidth: number;
	displayHeight: number;
};
