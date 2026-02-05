import type { RenderSpec } from "@cap/editor-render-spec";
import { composeFrame } from "@cap/editor-renderer";
import { createCanvas, loadImage } from "@napi-rs/canvas";

interface CompositorConfig {
	sourceWidth: number;
	sourceHeight: number;
	renderSpec: RenderSpec;
	backgroundImagePath: string | null;
}

const configPath = process.argv[2];
if (!configPath) {
	process.stderr.write("Usage: compositor-worker <config.json>\n");
	process.exit(1);
}

const configText = await Bun.file(configPath).text();
const config: CompositorConfig = JSON.parse(configText);

const { sourceWidth, sourceHeight, renderSpec } = config;
const frameByteSize = sourceWidth * sourceHeight * 4;

const outputCanvas = createCanvas(
	renderSpec.outputWidth,
	renderSpec.outputHeight,
);
const outputCtx = outputCanvas.getContext("2d");

const sourceCanvas = createCanvas(sourceWidth, sourceHeight);
const sourceCtx = sourceCanvas.getContext("2d");

let backgroundImage: InstanceType<
	typeof import("@napi-rs/canvas").Image
> | null = null;
let bgImageWidth = 0;
let bgImageHeight = 0;

if (config.backgroundImagePath) {
	try {
		backgroundImage = await loadImage(config.backgroundImagePath);
		bgImageWidth = backgroundImage.width;
		bgImageHeight = backgroundImage.height;
	} catch (err) {
		process.stderr.write(
			`Failed to load background image: ${err instanceof Error ? err.message : String(err)}\n`,
		);
	}
}

const stdin = Bun.stdin.stream();
const reader = stdin.getReader();
const stdout = Bun.stdout.writer();

let buffer = new Uint8Array(0);

function appendToBuffer(chunk: Uint8Array): void {
	const newBuffer = new Uint8Array(buffer.length + chunk.length);
	newBuffer.set(buffer);
	newBuffer.set(chunk, buffer.length);
	buffer = newBuffer;
}

while (true) {
	while (buffer.length >= frameByteSize) {
		const frameData = buffer.slice(0, frameByteSize);
		buffer = buffer.slice(frameByteSize);

		const imageData = sourceCtx.createImageData(sourceWidth, sourceHeight);
		imageData.data.set(frameData);
		sourceCtx.putImageData(imageData, 0, 0);

		composeFrame(
			outputCtx as unknown as CanvasRenderingContext2D,
			renderSpec,
			{ source: sourceCanvas, width: sourceWidth, height: sourceHeight },
			backgroundImage,
			bgImageWidth,
			bgImageHeight,
		);

		const outputImageData = outputCtx.getImageData(
			0,
			0,
			renderSpec.outputWidth,
			renderSpec.outputHeight,
		);

		stdout.write(outputImageData.data as unknown as Uint8Array);
	}

	const { done, value } = await reader.read();
	if (done) break;
	appendToBuffer(value);
}

if (buffer.length >= frameByteSize) {
	const frameData = buffer.slice(0, frameByteSize);

	const imageData = sourceCtx.createImageData(sourceWidth, sourceHeight);
	imageData.data.set(frameData);
	sourceCtx.putImageData(imageData, 0, 0);

	composeFrame(
		outputCtx as unknown as CanvasRenderingContext2D,
		renderSpec,
		{ source: sourceCanvas, width: sourceWidth, height: sourceHeight },
		backgroundImage,
		bgImageWidth,
		bgImageHeight,
	);

	const outputImageData = outputCtx.getImageData(
		0,
		0,
		renderSpec.outputWidth,
		renderSpec.outputHeight,
	);

	stdout.write(outputImageData.data as unknown as Uint8Array);
}

await stdout.flush();
process.exit(0);
