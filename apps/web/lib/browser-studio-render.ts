import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { getFfmpegPath } from "@/lib/audio-extract";
import type {
	BrowserStudioCloudManifest,
	BrowserStudioEditSettings,
	BrowserStudioManifestAsset,
	BrowserStudioManifestTrack,
	BrowserStudioTextOverlay,
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

export type BrowserStudioTextOverlayInput = {
	path: string;
	overlay: BrowserStudioTextOverlay;
};

export type BrowserStudioGradientBackgroundInput = {
	path: string;
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

const escapeXml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");

const rgbaColor = (value: string) => {
	if (/^#[0-9a-f]{8}$/i.test(value)) {
		const red = Number.parseInt(value.slice(1, 3), 16);
		const green = Number.parseInt(value.slice(3, 5), 16);
		const blue = Number.parseInt(value.slice(5, 7), 16);
		const alpha = Number.parseInt(value.slice(7), 16) / 255;

		return `rgba(${red}, ${green}, ${blue}, ${Number(alpha.toFixed(3))})`;
	}

	return /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
};

const svgColor = (value: string, fallback: string) =>
	/^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

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
	sourceWidth,
	sourceHeight,
	position,
	size,
	shape,
}: {
	outputWidth: number;
	outputHeight: number;
	sourceWidth: number | null;
	sourceHeight: number | null;
	position: BrowserStudioEditSettings["canvas"]["cameraPosition"];
	size: number;
	shape: BrowserStudioEditSettings["canvas"]["cameraShape"];
}) {
	const margin = even(Math.min(outputWidth, outputHeight) * 0.04);
	const safeSize = clamp(size, 10, 40) / 100;
	const width = even(outputWidth * safeSize);
	const sourceRatio =
		sourceWidth && sourceHeight && sourceWidth > 0 && sourceHeight > 0
			? sourceHeight / sourceWidth
			: outputHeight / outputWidth;
	const height =
		shape === "source"
			? even(width * sourceRatio)
			: even(outputHeight * safeSize);
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

const getValidTextOverlays = (edit: BrowserStudioEditSettings) =>
	edit.textOverlays
		.filter((overlay) => overlay.text.trim() && overlay.endMs > overlay.startMs)
		.slice(0, 12);

const wrapTextOverlay = (text: string, maxCharacters: number) => {
	const source = text.trim().replace(/\s+/g, " ").slice(0, 180);
	const words = source.split(" ");
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		const next = current ? `${current} ${word}` : word;

		if (next.length > maxCharacters && current) {
			lines.push(current);
			current = word;
		} else {
			current = next;
		}
	}

	if (current) {
		lines.push(current);
	}

	return lines.slice(0, 4);
};

async function createTextOverlayImage(
	overlay: BrowserStudioTextOverlay,
	outputWidth: number,
	dirPath: string,
	index: number,
) {
	const safeSize = Math.round(clamp(overlay.size, 20, 96));
	const maxCharacters = Math.max(10, Math.floor(900 / safeSize));
	const lines = wrapTextOverlay(overlay.text, maxCharacters);
	const horizontalPadding = Math.round(safeSize * 0.55);
	const verticalPadding = Math.round(safeSize * 0.36);
	const lineHeight = Math.round(safeSize * 1.22);
	const maxLineLength = Math.max(...lines.map((line) => line.length), 1);
	const width = even(
		Math.min(
			Math.max(160, maxLineLength * safeSize * 0.58 + horizontalPadding * 2),
			outputWidth * 0.82,
		),
	);
	const height = even(
		Math.max(
			safeSize + verticalPadding * 2,
			lines.length * lineHeight + verticalPadding * 2,
		),
	);
	const textNodes = lines
		.map(
			(line, lineIndex) =>
				`<text x="${horizontalPadding}" y="${verticalPadding + safeSize + lineIndex * lineHeight}" fill="${escapeXml(overlay.color)}" font-family="Inter, Arial, sans-serif" font-size="${safeSize}" font-weight="700">${escapeXml(line)}</text>`,
		)
		.join("");
	const radius = Math.round(safeSize * 0.35);
	const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" rx="${radius}" fill="${rgbaColor(overlay.background)}"/>${textNodes}</svg>`;
	const path = join(dirPath, `text-overlay-${index}.png`);

	await sharp(Buffer.from(svg)).png().toFile(path);

	return {
		path,
		overlay,
	};
}

async function createTextOverlayImages(
	plan: BrowserStudioRenderPlan,
	dirPath: string,
) {
	const overlays = getValidTextOverlays(plan.edit);

	return Promise.all(
		overlays.map((overlay, index) =>
			createTextOverlayImage(overlay, plan.outputWidth, dirPath, index),
		),
	);
}

async function createGradientBackgroundImage(
	plan: BrowserStudioRenderPlan,
	dirPath: string,
): Promise<BrowserStudioGradientBackgroundInput | null> {
	if (plan.edit.canvas.backgroundMode !== "gradient") {
		return null;
	}

	const gradient = plan.edit.canvas.backgroundGradient;
	const angle = clamp(gradient.angle, 0, 360);
	const radians = ((angle - 90) * Math.PI) / 180;
	const half = 50;
	const x = Math.cos(radians) * half;
	const y = Math.sin(radians) * half;
	const x1 = 50 - x;
	const y1 = 50 - y;
	const x2 = 50 + x;
	const y2 = 50 + y;
	const from = svgColor(gradient.from, "#4785ff");
	const to = svgColor(gradient.to, "#ff4766");
	const path = join(dirPath, "gradient-background.png");
	const svg = `<svg width="${plan.outputWidth}" height="${plan.outputHeight}" viewBox="0 0 ${plan.outputWidth} ${plan.outputHeight}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="bg" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%"><stop offset="0%" stop-color="${from}"/><stop offset="100%" stop-color="${to}"/></linearGradient></defs><rect width="${plan.outputWidth}" height="${plan.outputHeight}" fill="url(#bg)"/></svg>`;

	await sharp(Buffer.from(svg)).png().toFile(path);

	return { path };
}

export function appendGradientBackgroundInputToArgs(
	args: string[],
	input: BrowserStudioGradientBackgroundInput | null,
	outputWidth: number,
	outputHeight: number,
) {
	if (!input) {
		return args;
	}

	const filterIndex = args.indexOf("-filter_complex");

	if (filterIndex === -1 || filterIndex + 1 >= args.length) {
		return args;
	}

	const inputCount = args
		.slice(0, filterIndex)
		.filter((arg) => arg === "-i").length;
	const nextArgs = [
		...args.slice(0, filterIndex),
		"-loop",
		"1",
		"-i",
		input.path,
		...args.slice(filterIndex),
	];
	const nextFilterIndex = filterIndex + 4;
	const filterGraph = nextArgs[nextFilterIndex + 1];

	if (!filterGraph) {
		return nextArgs;
	}

	const filters = filterGraph.split(";");
	const backgroundFilterIndex = filters.findIndex((filter) =>
		filter.endsWith("[bg]"),
	);

	if (backgroundFilterIndex === -1) {
		return nextArgs;
	}

	filters[backgroundFilterIndex] =
		`[${inputCount}:v]scale=${outputWidth}:${outputHeight},setsar=1[bg]`;
	nextArgs[nextFilterIndex + 1] = filters.join(";");

	return nextArgs;
}

export function appendTextOverlayInputsToArgs(
	args: string[],
	textInputs: BrowserStudioTextOverlayInput[],
	trimStartSeconds: number,
	outputWidth: number,
	outputHeight: number,
) {
	if (textInputs.length === 0) {
		return args;
	}

	const filterIndex = args.indexOf("-filter_complex");
	const firstMapIndex = args.indexOf("-map");

	if (
		filterIndex === -1 ||
		firstMapIndex === -1 ||
		filterIndex + 1 >= args.length
	) {
		return args;
	}

	const mappedVideoLabel = args[firstMapIndex + 1];

	if (!mappedVideoLabel?.startsWith("[") || !mappedVideoLabel.endsWith("]")) {
		return args;
	}

	const inputCount = args
		.slice(0, filterIndex)
		.filter((arg) => arg === "-i").length;
	const imageInputArgs = textInputs.flatMap((input) => [
		"-loop",
		"1",
		"-i",
		input.path,
	]);
	const nextArgs = [
		...args.slice(0, filterIndex),
		...imageInputArgs,
		...args.slice(filterIndex),
	];
	const nextFilterIndex = filterIndex + imageInputArgs.length;
	const nextFirstMapIndex = firstMapIndex + imageInputArgs.length;
	let videoLabel = mappedVideoLabel;
	const overlayFilters = textInputs.map((input, index) => {
		const inputIndex = inputCount + index;
		const outputLabel = `[vtext${index}]`;
		const overlay = input.overlay;
		const start = Math.max(0, seconds(overlay.startMs) - trimStartSeconds);
		const end = Math.max(start, seconds(overlay.endMs) - trimStartSeconds);
		const x = expressionNumber(clamp(overlay.x, 0, 1));
		const y = expressionNumber(clamp(overlay.y, 0, 1));
		const filter = `${videoLabel}[${inputIndex}:v]overlay=x='(${outputWidth}-w)*${x}':y='(${outputHeight}-h)*${y}':enable='between(t,${Number(start.toFixed(3))},${Number(end.toFixed(3))})'${outputLabel}`;

		videoLabel = outputLabel;

		return filter;
	});

	nextArgs[nextFilterIndex + 1] =
		`${nextArgs[nextFilterIndex + 1]};${overlayFilters.join(";")}`;
	nextArgs[nextFirstMapIndex + 1] = videoLabel;

	return nextArgs;
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
			sourceWidth: selected.camera.asset.width,
			sourceHeight: selected.camera.asset.height,
			position: edit.canvas.cameraPosition,
			size: edit.canvas.cameraSize,
			shape: edit.canvas.cameraShape,
		});
		const cameraSourceLabel = edit.canvas.cameraMirror ? "[camflip]" : "[1:v]";
		if (edit.canvas.cameraMirror) {
			filters.push("[1:v]hflip[camflip]");
		}
		filters.push(
			`${cameraSourceLabel}scale=${camera.width}:${camera.height}:force_original_aspect_ratio=decrease,setsar=1[cam]`,
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
		const gradientInput = await createGradientBackgroundImage(plan, dirPath);
		const textInputs = await createTextOverlayImages(plan, dirPath);
		const argsWithGradient = appendGradientBackgroundInputToArgs(
			plan.args,
			gradientInput,
			plan.outputWidth,
			plan.outputHeight,
		);
		const argsWithoutAudioWithGradient = appendGradientBackgroundInputToArgs(
			plan.argsWithoutAudio,
			gradientInput,
			plan.outputWidth,
			plan.outputHeight,
		);
		const args = appendTextOverlayInputsToArgs(
			argsWithGradient,
			textInputs,
			plan.trimStartSeconds,
			plan.outputWidth,
			plan.outputHeight,
		);
		const argsWithoutAudio = appendTextOverlayInputsToArgs(
			argsWithoutAudioWithGradient,
			textInputs,
			plan.trimStartSeconds,
			plan.outputWidth,
			plan.outputHeight,
		);

		try {
			await runFfmpeg(ffmpeg, [...args, filePath]);
		} catch (error) {
			if (!plan.audioEnabled) {
				throw error;
			}

			await runFfmpeg(ffmpeg, [...argsWithoutAudio, filePath]);
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
