import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFfmpegPath } from "@/lib/audio-extract";
import type {
	BrowserStudioCloudManifest,
	BrowserStudioEditSettings,
	BrowserStudioManifestAsset,
	BrowserStudioManifestTrack,
} from "@/lib/browser-studio";
import { getBrowserStudioEditSettings } from "@/lib/browser-studio";

export type BrowserStudioRenderSource = {
	asset: BrowserStudioManifestAsset;
	track: BrowserStudioManifestTrack | null;
	url: string;
};

export type BrowserStudioRenderPlan = {
	primary: BrowserStudioRenderSource;
	camera: BrowserStudioRenderSource | null;
	edit: BrowserStudioEditSettings;
	durationMs: number;
	outputWidth: number;
	outputHeight: number;
	trimStartSeconds: number;
	trimDurationSeconds: number;
	audioEnabled: boolean;
	args: string[];
	argsWithoutAudio: string[];
};

type SourceInput = {
	subpath: string;
	url: string;
};

type LayoutInput = {
	sourceWidth: number | null;
	sourceHeight: number | null;
	aspectRatio: BrowserStudioEditSettings["canvas"]["aspectRatio"];
	padding: number;
};

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const MIN_DURATION_MS = 500;

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

const clamp = (value: number, min: number, max: number) =>
	Math.min(Math.max(value, min), max);

const colorToFfmpeg = (value: string) =>
	/^#[0-9a-f]{6}$/i.test(value) ? `0x${value.slice(1)}` : "0x111111";

const seconds = (ms: number) => Number((ms / 1000).toFixed(3));

const expressionNumber = (value: number) => Number(value.toFixed(4));

const getActiveZoomExpression = (
	edit: BrowserStudioEditSettings,
	trimStartMs: number,
) => {
	const validSegments = edit.zooms
		.filter((zoom) => zoom.endMs > zoom.startMs && zoom.scale > 1)
		.slice(0, 20);

	if (validSegments.length === 0) {
		return {
			scale: expressionNumber(edit.canvas.scale).toString(),
			originX: "0.5",
			originY: "0.5",
		};
	}

	return validSegments.reduce(
		(expressions, zoom) => {
			const start = seconds(Math.max(0, zoom.startMs - trimStartMs));
			const end = seconds(Math.max(0, zoom.endMs - trimStartMs));
			const scale = expressionNumber(
				edit.canvas.scale * clamp(zoom.scale, 1, 4),
			);
			const originX = expressionNumber(clamp(zoom.originX, 0.05, 0.95));
			const originY = expressionNumber(clamp(zoom.originY, 0.05, 0.95));
			const active = `between(t,${start},${end})`;

			return {
				scale: `if(${active},${scale},${expressions.scale})`,
				originX: `if(${active},${originX},${expressions.originX})`,
				originY: `if(${active},${originY},${expressions.originY})`,
			};
		},
		{
			scale: expressionNumber(edit.canvas.scale).toString(),
			originX: "0.5",
			originY: "0.5",
		},
	);
};

export function getBrowserStudioCanvasRatio(
	aspectRatio: BrowserStudioEditSettings["canvas"]["aspectRatio"],
	sourceWidth: number,
	sourceHeight: number,
) {
	if (aspectRatio === "16:9") return 16 / 9;
	if (aspectRatio === "1:1") return 1;
	if (aspectRatio === "9:16") return 9 / 16;
	return sourceWidth / sourceHeight;
}

export function getBrowserStudioRenderLayout({
	sourceWidth,
	sourceHeight,
	aspectRatio,
	padding,
}: LayoutInput) {
	const normalizedSourceWidth =
		sourceWidth && sourceWidth > 0 ? sourceWidth : DEFAULT_WIDTH;
	const normalizedSourceHeight =
		sourceHeight && sourceHeight > 0 ? sourceHeight : DEFAULT_HEIGHT;
	const ratio = getBrowserStudioCanvasRatio(
		aspectRatio,
		normalizedSourceWidth,
		normalizedSourceHeight,
	);
	const sourceRatio = normalizedSourceWidth / normalizedSourceHeight;
	const outputWidth =
		ratio >= sourceRatio
			? even(normalizedSourceHeight * ratio)
			: even(normalizedSourceWidth);
	const outputHeight =
		ratio >= sourceRatio
			? even(normalizedSourceHeight)
			: even(normalizedSourceWidth / ratio);
	const safePadding = clamp(padding, 0, 30) / 100;
	const contentWidth = even(outputWidth * Math.max(0.1, 1 - safePadding * 2));
	const contentHeight = even(outputHeight * Math.max(0.1, 1 - safePadding * 2));

	return {
		outputWidth,
		outputHeight,
		contentWidth,
		contentHeight,
	};
}

export function getBrowserStudioTrimRange(
	edit: BrowserStudioEditSettings,
	durationMs: number | null,
) {
	const safeDuration =
		durationMs && durationMs > 0 ? durationMs : MIN_DURATION_MS;
	const startMs = clamp(edit.trim.startMs, 0, Math.max(0, safeDuration - 1));
	const requestedEndMs = edit.trim.endMs ?? safeDuration;
	const endMs = clamp(requestedEndMs, startMs + 1, safeDuration);

	return {
		startMs,
		endMs,
		durationMs: Math.max(1, endMs - startMs),
	};
}

export function selectBrowserStudioRenderSources(
	manifest: BrowserStudioCloudManifest,
	sources: SourceInput[],
) {
	const sourceBySubpath = new Map(
		sources.map((source) => [source.subpath, source]),
	);
	const trackByAssetId = new Map(
		manifest.project.timeline.tracks.map((track) => [track.assetId, track]),
	);
	const candidateAssets = manifest.assets.filter((asset) =>
		sourceBySubpath.has(asset.sourceSubpath),
	);
	const primaryAsset =
		candidateAssets.find(
			(asset) => asset.kind === "screen" || asset.kind === "mixed",
		) ?? candidateAssets[0];

	if (!primaryAsset) {
		throw new Error("Studio render source is missing");
	}

	const primaryTrack = trackByAssetId.get(primaryAsset.assetId) ?? null;
	const primarySource = sourceBySubpath.get(primaryAsset.sourceSubpath);

	if (!primarySource) {
		throw new Error("Studio primary source is missing");
	}

	const cameraAsset =
		candidateAssets.find((asset) => {
			const track = trackByAssetId.get(asset.assetId);
			return asset.kind === "camera" && track?.muted !== true;
		}) ?? null;
	const cameraSource = cameraAsset
		? sourceBySubpath.get(cameraAsset.sourceSubpath)
		: null;

	return {
		primary: {
			asset: primaryAsset,
			track: primaryTrack,
			url: primarySource.url,
		},
		camera:
			cameraAsset && cameraSource
				? {
						asset: cameraAsset,
						track: trackByAssetId.get(cameraAsset.assetId) ?? null,
						url: cameraSource.url,
					}
				: null,
	};
}

function getCameraOverlay({
	outputWidth,
	outputHeight,
	position,
	size,
}: {
	outputWidth: number;
	outputHeight: number;
	position: BrowserStudioEditSettings["canvas"]["cameraPosition"];
	size: number;
}) {
	const margin = even(Math.min(outputWidth, outputHeight) * 0.04);
	const safeSize = clamp(size, 10, 40) / 100;
	const width = even(outputWidth * safeSize);
	const height = even(outputHeight * safeSize);
	const x =
		position === "top-left" || position === "bottom-left"
			? margin
			: `W-w-${margin}`;
	const y =
		position === "top-left" || position === "top-right"
			? margin
			: `H-h-${margin}`;

	return { width, height, x, y };
}

export function buildBrowserStudioRenderPlan(
	manifest: BrowserStudioCloudManifest,
	sources: SourceInput[],
): BrowserStudioRenderPlan {
	const edit = getBrowserStudioEditSettings(manifest);
	const selected = selectBrowserStudioRenderSources(manifest, sources);
	const timelineDurationMs = manifest.project.timeline.durationMs;
	const trackDurationMs = selected.primary.track?.durationMs ?? null;
	const assetDurationMs = trackDurationMs ?? timelineDurationMs;
	const trim = getBrowserStudioTrimRange(edit, assetDurationMs);
	const layout = getBrowserStudioRenderLayout({
		sourceWidth: selected.primary.asset.width,
		sourceHeight: selected.primary.asset.height,
		aspectRatio: edit.canvas.aspectRatio,
		padding: edit.canvas.padding,
	});
	const trimStartSeconds = seconds(trim.startMs);
	const trimDurationSeconds = seconds(trim.durationMs);
	const inputArgs = [
		"-ss",
		String(trimStartSeconds),
		"-t",
		String(trimDurationSeconds),
		"-i",
		selected.primary.url,
	];
	if (selected.camera) {
		inputArgs.push(
			"-ss",
			String(trimStartSeconds),
			"-t",
			String(trimDurationSeconds),
			"-i",
			selected.camera.url,
		);
	}

	const zoomExpression = getActiveZoomExpression(edit, trim.startMs);
	const scaledWidthExpression = `trunc(iw*${zoomExpression.scale}/2)*2`;
	const scaledHeightExpression = `trunc(ih*${zoomExpression.scale}/2)*2`;
	const desiredXExpression = `W/2-w*${zoomExpression.originX}`;
	const desiredYExpression = `H/2-h*${zoomExpression.originY}`;
	const overlayXExpression = `if(gte(W,w),min(W-w,max(0,${desiredXExpression})),min(0,max(W-w,${desiredXExpression})))`;
	const overlayYExpression = `if(gte(H,h),min(H-h,max(0,${desiredYExpression})),min(0,max(H-h,${desiredYExpression})))`;
	const contentSourceLabel =
		edit.canvas.backgroundMode === "blur" ? "[fgsrc]" : "[0:v]";
	const filters =
		edit.canvas.backgroundMode === "blur"
			? [
					"[0:v]split=2[bgsrc][fgsrc]",
					`[bgsrc]scale=${layout.outputWidth}:${layout.outputHeight}:force_original_aspect_ratio=increase,crop=${layout.outputWidth}:${layout.outputHeight},boxblur=24:1,setsar=1[bg]`,
					`${contentSourceLabel}scale=${layout.contentWidth}:${layout.contentHeight}:force_original_aspect_ratio=decrease,scale=w='${scaledWidthExpression}':h='${scaledHeightExpression}':eval=frame,setsar=1[v0]`,
					`[bg][v0]overlay=x='${overlayXExpression}':y='${overlayYExpression}':eval=frame:shortest=1[vbase]`,
				]
			: [
					`color=c=${colorToFfmpeg(edit.canvas.background)}:s=${layout.outputWidth}x${layout.outputHeight}:d=${trimDurationSeconds}[bg]`,
					`${contentSourceLabel}scale=${layout.contentWidth}:${layout.contentHeight}:force_original_aspect_ratio=decrease,scale=w='${scaledWidthExpression}':h='${scaledHeightExpression}':eval=frame,setsar=1[v0]`,
					`[bg][v0]overlay=x='${overlayXExpression}':y='${overlayYExpression}':eval=frame:shortest=1[vbase]`,
				];
	let videoLabel = "[vbase]";

	if (selected.camera) {
		const camera = getCameraOverlay({
			outputWidth: layout.outputWidth,
			outputHeight: layout.outputHeight,
			position: edit.canvas.cameraPosition,
			size: edit.canvas.cameraSize,
		});
		filters.push(
			`[1:v]scale=${camera.width}:${camera.height}:force_original_aspect_ratio=decrease,setsar=1[cam]`,
			`[vbase][cam]overlay=${camera.x}:${camera.y}:shortest=1[vout]`,
		);
		videoLabel = "[vout]";
	}

	const audioEnabled =
		selected.primary.track?.muted !== true && edit.audio.volume > 0;
	const args = [
		"-y",
		...inputArgs,
		"-filter_complex",
		filters.join(";"),
		"-map",
		videoLabel,
	];

	if (audioEnabled) {
		args.push("-map", "0:a?", "-af", `volume=${edit.audio.volume}`);
	} else {
		args.push("-an");
	}

	args.push(
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"18",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-b:a",
		"160k",
		"-movflags",
		"+faststart",
	);
	const argsWithoutAudio = [
		"-y",
		...inputArgs,
		"-filter_complex",
		filters.join(";"),
		"-map",
		videoLabel,
		"-an",
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"18",
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
	];

	return {
		...selected,
		edit,
		durationMs: trim.durationMs,
		outputWidth: layout.outputWidth,
		outputHeight: layout.outputHeight,
		trimStartSeconds,
		trimDurationSeconds,
		audioEnabled,
		args,
		argsWithoutAudio,
	};
}

export async function renderBrowserStudioMp4(
	plan: BrowserStudioRenderPlan,
): Promise<{
	filePath: string;
	thumbnailPath: string;
	cleanup: () => Promise<void>;
}> {
	const dirPath = await fs.mkdtemp(join(tmpdir(), "cap-studio-render-"));
	const filePath = join(dirPath, `${randomUUID()}.mp4`);
	const thumbnailPath = join(dirPath, `${randomUUID()}.jpg`);
	const ffmpeg = getFfmpegPath();

	try {
		try {
			await runFfmpeg(ffmpeg, [...plan.args, filePath]);
		} catch (error) {
			if (!plan.audioEnabled) {
				throw error;
			}

			await runFfmpeg(ffmpeg, [...plan.argsWithoutAudio, filePath]);
		}
		await runFfmpeg(ffmpeg, [
			"-y",
			"-ss",
			"0.1",
			"-i",
			filePath,
			"-frames:v",
			"1",
			"-q:v",
			"2",
			thumbnailPath,
		]);

		return {
			filePath,
			thumbnailPath,
			cleanup: async () => {
				await fs.rm(dirPath, { force: true, recursive: true }).catch(() => {});
			},
		};
	} catch (error) {
		await fs.rm(dirPath, { force: true, recursive: true }).catch(() => {});
		throw error;
	}
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (error: Error) => {
			reject(new Error(`Studio render failed: ${error.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve();
				return;
			}

			reject(new Error(`Studio render failed with code ${code}: ${stderr}`));
		});
	});
}
