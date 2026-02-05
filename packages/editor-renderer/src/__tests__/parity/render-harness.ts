import type { RenderSpec } from "@cap/editor-render-spec";
import { computeRenderSpec } from "@cap/editor-render-spec";
import { createCanvas } from "@napi-rs/canvas";
import { composeFrame } from "../../compose-frame";
import type { GoldenConfig } from "./golden-configs";

export interface RenderResult {
	png: Buffer;
	width: number;
	height: number;
	spec: RenderSpec;
}

export function renderGolden(goldenConfig: GoldenConfig): RenderResult {
	const spec = computeRenderSpec(
		goldenConfig.config,
		goldenConfig.sourceWidth,
		goldenConfig.sourceHeight,
	);

	const canvas = createCanvas(spec.outputWidth, spec.outputHeight);
	const ctx = canvas.getContext("2d");

	const sourceCanvas = createCanvas(
		goldenConfig.sourceWidth,
		goldenConfig.sourceHeight,
	);
	const sourceCtx = sourceCanvas.getContext("2d");

	const gradient = sourceCtx.createLinearGradient(
		0,
		0,
		goldenConfig.sourceWidth,
		goldenConfig.sourceHeight,
	);
	gradient.addColorStop(0, "rgb(60, 60, 80)");
	gradient.addColorStop(0.5, "rgb(80, 80, 100)");
	gradient.addColorStop(1, "rgb(100, 100, 120)");
	sourceCtx.fillStyle = gradient;
	sourceCtx.fillRect(0, 0, goldenConfig.sourceWidth, goldenConfig.sourceHeight);

	sourceCtx.fillStyle = "rgb(200, 200, 200)";
	const centerX = goldenConfig.sourceWidth / 2;
	const centerY = goldenConfig.sourceHeight / 2;
	const triangleSize =
		Math.min(goldenConfig.sourceWidth, goldenConfig.sourceHeight) * 0.15;
	sourceCtx.beginPath();
	sourceCtx.moveTo(centerX - triangleSize / 2, centerY + triangleSize / 2);
	sourceCtx.lineTo(centerX + triangleSize, centerY);
	sourceCtx.lineTo(centerX - triangleSize / 2, centerY - triangleSize / 2);
	sourceCtx.closePath();
	sourceCtx.fill();

	composeFrame(
		ctx as unknown as CanvasRenderingContext2D,
		spec,
		{
			source: sourceCanvas,
			width: goldenConfig.sourceWidth,
			height: goldenConfig.sourceHeight,
		},
		null,
		0,
		0,
	);

	const png = canvas.toBuffer("image/png");

	return {
		png,
		width: spec.outputWidth,
		height: spec.outputHeight,
		spec,
	};
}

export function getGoldenPath(name: string): string {
	return new URL(`./goldens/${name}.png`, import.meta.url).pathname;
}
