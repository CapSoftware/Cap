import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { processVideoWithCanvasPipeline } from "../../lib/canvas-pipeline";
import { processVideoWithTimeline } from "../../lib/ffmpeg-video";
import { probeVideo } from "../../lib/ffprobe";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_VIDEO_WITH_AUDIO = join(FIXTURES_DIR, "test-with-audio.mp4");
const WEB_BACKGROUND = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"..",
	"web",
	"public",
	"backgrounds",
	"blue",
	"1.jpg",
);

const tempFiles: string[] = [];

afterAll(() => {
	for (const file of tempFiles) {
		if (existsSync(file)) {
			rmSync(file);
		}
	}
});

function samplePixel(
	path: string,
	x: number,
	y: number,
): [number, number, number] {
	const data = execFileSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-i",
			path,
			"-vf",
			`format=rgb24,crop=1:1:${x}:${y}`,
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			"pipe:1",
		],
		{ encoding: "buffer" },
	);

	if (data.length < 3) {
		throw new Error("Failed to read pixel data from output video");
	}

	return [data[0], data[1], data[2]];
}

function colorDistance(
	a: [number, number, number],
	b: [number, number, number],
): number {
	const dr = a[0] - b[0];
	const dg = a[1] - b[1];
	const db = a[2] - b[2];
	return Math.sqrt(dr * dr + dg * dg + db * db);
}

describe("processVideoWithCanvasPipeline integration tests", () => {
	test("applies editor background layout with padding, rounding, and shadow", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);

		const output = await processVideoWithCanvasPipeline(
			TEST_VIDEO_WITH_AUDIO,
			metadata,
			[{ start: 0, end: metadata.duration, timescale: 1 }],
			{
				aspectRatio: "wide",
				background: {
					source: {
						type: "color",
						value: [250, 0, 250],
					},
					padding: 12,
					rounding: 80,
					roundingType: "squircle",
					shadow: 80,
					advancedShadow: {
						size: 60,
						opacity: 80,
						blur: 60,
					},
				},
			},
		);
		tempFiles.push(output.path);

		const outputMetadata = await probeVideo(`file://${output.path}`);
		expect(outputMetadata.width).toBe(428);
		expect(outputMetadata.height).toBe(240);

		const cornerPixel = samplePixel(output.path, 2, 2);
		const centerPixel = samplePixel(output.path, 214, 120);

		expect(colorDistance(cornerPixel, [250, 0, 250])).toBeLessThan(90);
		expect(colorDistance(centerPixel, [250, 0, 250])).toBeGreaterThan(50);

		await output.cleanup();
	}, 120000);

	test("renders wallpaper background via canvas pipeline", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);

		const output = await processVideoWithCanvasPipeline(
			TEST_VIDEO_WITH_AUDIO,
			metadata,
			[{ start: 0, end: metadata.duration, timescale: 1 }],
			{
				background: {
					source: {
						type: "wallpaper",
						path: WEB_BACKGROUND,
					},
					padding: 10,
					rounding: 0,
					shadow: 0,
				},
			},
		);
		tempFiles.push(output.path);

		const outputMetadata = await probeVideo(`file://${output.path}`);
		expect(outputMetadata.width).toBe(320);
		expect(outputMetadata.height).toBe(240);

		const cornerPixel = samplePixel(output.path, 2, 2);
		const centerPixel = samplePixel(output.path, 160, 120);

		expect(colorDistance(cornerPixel, centerPixel)).toBeGreaterThan(20);

		await output.cleanup();
	}, 120000);

	test("renders gradient background via canvas pipeline", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);

		const output = await processVideoWithCanvasPipeline(
			TEST_VIDEO_WITH_AUDIO,
			metadata,
			[{ start: 0, end: metadata.duration, timescale: 1 }],
			{
				background: {
					source: {
						type: "gradient",
						from: [255, 0, 0],
						to: [0, 0, 255],
						angle: 180,
					},
					padding: 10,
					rounding: 0,
					shadow: 0,
				},
			},
		);
		tempFiles.push(output.path);

		const outputMetadata = await probeVideo(`file://${output.path}`);
		expect(outputMetadata.width).toBe(320);
		expect(outputMetadata.height).toBe(240);

		const topLeftPixel = samplePixel(output.path, 2, 2);
		const bottomRightPixel = samplePixel(
			output.path,
			outputMetadata.width - 3,
			outputMetadata.height - 3,
		);

		expect(colorDistance(topLeftPixel, bottomRightPixel)).toBeGreaterThan(30);

		await output.cleanup();
	}, 120000);

	test("abort cancels all processes", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);
		const abortController = new AbortController();

		abortController.abort();

		await expect(
			processVideoWithCanvasPipeline(
				TEST_VIDEO_WITH_AUDIO,
				metadata,
				[{ start: 0, end: metadata.duration, timescale: 1 }],
				{
					background: {
						source: {
							type: "color",
							value: [250, 0, 250],
						},
						padding: 12,
						rounding: 80,
						shadow: 80,
					},
				},
				{},
				undefined,
				abortController.signal,
			),
		).rejects.toThrow();
	}, 30000);

	test("legacy fallback with CAP_CANVAS_RENDERER=false", async () => {
		const originalEnv = process.env.CAP_CANVAS_RENDERER;
		process.env.CAP_CANVAS_RENDERER = "false";

		try {
			const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);

			const output = await processVideoWithTimeline(
				TEST_VIDEO_WITH_AUDIO,
				metadata,
				[{ start: 0, end: metadata.duration, timescale: 1 }],
				{
					background: {
						source: {
							type: "color",
							value: [250, 0, 250],
						},
						padding: 12,
						rounding: 0,
						shadow: 0,
					},
				},
			);
			tempFiles.push(output.path);

			const outputMetadata = await probeVideo(`file://${output.path}`);
			expect(outputMetadata.width).toBe(320);
			expect(outputMetadata.height).toBe(240);

			await output.cleanup();
		} finally {
			if (originalEnv === undefined) {
				delete process.env.CAP_CANVAS_RENDERER;
			} else {
				process.env.CAP_CANVAS_RENDERER = originalEnv;
			}
		}
	}, 60000);
});
