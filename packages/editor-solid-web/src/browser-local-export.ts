import type {
	BrowserExportAudioSource,
	BrowserExportJob,
	BrowserExportMessage,
} from "./browser-export-worker";
import {
	browserEditorPreviewConfig,
	browserEditorVideoId,
} from "./browser-frame-socket";
import { probeBrowserMedia } from "./browser-media-probe";
import { loadBrowserRenderer } from "./browser-renderer";
import { BROWSER_RENDERER_FONT_URLS } from "./browser-renderer-fonts";
import { BrowserEditorSourceCatalog } from "./browser-sources";
import { studioRecordingMeta, webInputRecording } from "./browser-studio-setup";
import { emitEditorChannel } from "./channels";
import { resolveEditorAssetUrl } from "./editor-asset-url";

const COMPRESSION_BPP: Record<string, number> = {
	Maximum: 0.3,
	Social: 0.15,
	Web: 0.08,
	Potato: 0.04,
};

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function absolute(url: string) {
	return new URL(url, window.location.href).href;
}

function assetUrl(path: string) {
	const url = resolveEditorAssetUrl(path);
	return url ? absolute(url) : null;
}

function segmentPaths(value: unknown) {
	return Array.isArray(value)
		? value.flatMap((entry) => {
				const path = record(entry)?.path;
				return typeof path === "string" && path ? [path] : [];
			})
		: [];
}

function hasTextOverlays(config: Record<string, unknown>) {
	const timeline = record(config.timeline);
	return [
		timeline?.textSegments,
		timeline?.captionSegments,
		timeline?.keyboardSegments,
		record(config.captions)?.segments,
	].some((value) => Array.isArray(value) && value.length > 0);
}

/// Local export needs WebGPU and WebCodecs inside a worker.
export function browserLocalExportSupported() {
	return (
		typeof Worker === "function" &&
		typeof OffscreenCanvas === "function" &&
		typeof VideoEncoder === "function" &&
		typeof VideoDecoder === "function" &&
		typeof AudioEncoder === "function" &&
		"gpu" in navigator &&
		browserEditorVideoId() !== null
	);
}

export class BrowserLocalExportUnavailable extends Error {}

type WorkerListener = (message: BrowserExportMessage) => void;

/// One worker per editor: previews keep its renderer and decoders warm, and
/// an export that follows reuses them.
let workerState: { worker: Worker; listeners: Set<WorkerListener> } | null =
	null;
let activeExport: { reject: (error: Error) => void } | null = null;
let nextPreviewId = 1;

function exportWorker() {
	if (workerState) return workerState;
	const worker = new Worker(
		new URL("./browser-export-worker.ts", import.meta.url),
		{
			type: "module",
		},
	);
	const listeners = new Set<WorkerListener>();
	const state = { worker, listeners };
	worker.addEventListener(
		"message",
		(event: MessageEvent<BrowserExportMessage>) => {
			for (const listener of [...listeners]) listener(event.data);
		},
	);
	worker.addEventListener("error", (event) => {
		const message: BrowserExportMessage = {
			kind: "error",
			message: event.message || "Export worker failed",
		};
		for (const listener of [...listeners]) listener(message);
		resetExportWorker();
	});
	workerState = state;
	return state;
}

function resetExportWorker() {
	workerState?.worker.terminate();
	workerState = null;
}

export function cancelBrowserLocalExport() {
	if (!activeExport) return false;
	resetExportWorker();
	activeExport.reject(new Error("Export cancelled"));
	activeExport = null;
	return true;
}

async function exportJob(
	videoId: string,
	settings: Record<string, unknown>,
	signal: AbortSignal,
): Promise<BrowserExportJob> {
	const config = record(browserEditorPreviewConfig());
	if (!config)
		throw new BrowserLocalExportUnavailable("Editor project is loading");
	const catalog = new BrowserEditorSourceCatalog(videoId);
	try {
		const [sources, module] = await Promise.all([
			catalog.snapshot(signal),
			loadBrowserRenderer(),
		]);
		const first = sources.segments[0];
		if (!first?.display)
			throw new Error("Editor display recording is unavailable");
		const [display, camera, mic, input] = await Promise.all([
			probeBrowserMedia(first.display.url, signal),
			first.camera ? probeBrowserMedia(first.camera.url, signal) : null,
			sources.mic
				? probeBrowserMedia(sources.mic.url, signal).catch(() => null)
				: null,
			webInputRecording(sources, module, signal),
		]);
		if (display.width === null || display.height === null) {
			throw new Error("Editor recording dimensions are unavailable");
		}
		const firstDuration = Math.max(
			display.duration,
			camera?.duration ?? 0,
			mic?.duration ?? 0,
		);
		const sourceDurations = sources.segments.map((segment, index) =>
			index === 0 ? firstDuration : (segment.duration ?? 0),
		);
		const audio: BrowserExportAudioSource[] = [];
		if (sources.mic)
			audio.push({
				url: sources.mic.url,
				kind: "mic",
				segment: 0,
				offsetSeconds: 0,
			});
		if (sources.systemAudio)
			audio.push({
				url: sources.systemAudio.url,
				kind: "system",
				segment: 0,
				offsetSeconds: 0,
			});
		sources.segments.forEach((segment, index) => {
			const embedded = index === 0 ? sources.displayHasAudio : segment.hasAudio;
			if (embedded && segment.display)
				audio.push({
					url: segment.display.url,
					kind: "display",
					segment: index,
					offsetSeconds: 0,
				});
		});
		const timeline = record(config.timeline);
		const background = record(record(config.background)?.source);
		const imagePaths = [
			...(background &&
			(background.type === "image" || background.type === "wallpaper") &&
			typeof background.path === "string" &&
			background.path
				? [background.path]
				: []),
			...segmentPaths(timeline?.imageSegments),
		];
		const assetUrls: Record<string, string> = {};
		for (const path of imagePaths) {
			const url = assetUrl(path);
			if (url) assetUrls[path] = url;
		}
		const musicUrls: Record<string, string> = {};
		for (const path of segmentPaths(timeline?.audioSegments)) {
			const url = assetUrl(path);
			if (url) musicUrls[path] = url;
		}
		const resolution = record(settings.resolution_base);
		const fps = Number(settings.fps);
		const compression = String(settings.compression ?? "Maximum");
		const customBpp = settings.custom_bpp;
		if (
			!Number.isSafeInteger(fps) ||
			fps < 1 ||
			fps > 120 ||
			!resolution ||
			!Number.isSafeInteger(resolution.x) ||
			!Number.isSafeInteger(resolution.y)
		) {
			throw new Error("Editor export settings were invalid");
		}
		return {
			kind: "export",
			config,
			setup: {
				recordingMeta: studioRecordingMeta(sources, input),
				screenWidth: display.width,
				screenHeight: display.height,
				cameraWidth: camera?.width ?? 0,
				cameraHeight: camera?.height ?? 0,
				cursors: sources.segments.map((_, index) =>
					index === 0 && input ? JSON.stringify(input.cursor) : null,
				),
			},
			studioMeta: studioRecordingMeta(sources, input),
			sourceDurations,
			tracks: sources.segments.map((segment) => ({
				display: segment.display?.url ?? null,
				camera: segment.camera?.url ?? null,
			})),
			inputEventsUrl: sources.inputEvents?.url ?? null,
			audio,
			musicUrls,
			assetUrls,
			fontUrls: hasTextOverlays(config)
				? BROWSER_RENDERER_FONT_URLS.map((url) => url.href)
				: [],
			fps,
			resolutionBase: { x: Number(resolution.x), y: Number(resolution.y) },
			bitsPerPixel:
				typeof customBpp === "number" &&
				Number.isFinite(customBpp) &&
				customBpp > 0
					? customBpp
					: (COMPRESSION_BPP[compression] ?? 0.3),
		};
	} finally {
		catalog.dispose();
	}
}

function download(data: ArrayBuffer, mimeType: string, fileName: string) {
	const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	link.style.display = "none";
	document.body.append(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/// Renders and encodes the export on this machine and saves it as a download.
/// Throws `BrowserLocalExportUnavailable` before any frame renders when the
/// browser cannot export locally, so the caller can use the worker instead.
function localVideoId(settings: Record<string, unknown>) {
	const videoId = browserEditorVideoId();
	if (
		!videoId ||
		settings.format !== "Mp4" ||
		settings.optimize_filesize === true ||
		!browserLocalExportSupported()
	) {
		throw new BrowserLocalExportUnavailable("Local export is unavailable");
	}
	return videoId;
}

const THROUGHPUT_KEY = "cap-web-editor-export-throughput";

function measuredThroughput() {
	try {
		const value = Number(window.localStorage.getItem(THROUGHPUT_KEY));
		return Number.isFinite(value) && value > 0 ? value : null;
	} catch {
		return null;
	}
}

function rememberThroughput(pixelsPerSecond: number) {
	try {
		window.localStorage.setItem(
			THROUGHPUT_KEY,
			String(Math.round(pixelsPerSecond)),
		);
	} catch {}
}

/// Native export size model (`estimate_export`): video at the settings'
/// bits per pixel plus 192 kb/s audio, at 50% encoder efficiency.
function estimatedSizeMb(settings: BrowserExportJob, durationSeconds: number) {
	const effectiveFps =
		Math.max(settings.fps - 30, 0) * 0.6 + Math.min(settings.fps, 30);
	const pixels = settings.resolutionBase.x * settings.resolutionBase.y;
	const bitrate = pixels * settings.bitsPerPixel * effectiveFps + 192_000;
	return (bitrate * 0.5 * durationSeconds) / (8 * 1024 * 1024);
}

export async function browserLocalExportPreview(
	frameTime: number,
	previewSettings: Record<string, unknown>,
) {
	const bpp = Number(previewSettings.compression_bpp);
	const settings = {
		format: "Mp4",
		fps: previewSettings.fps,
		resolution_base: previewSettings.resolution_base,
		compression: "Maximum",
		custom_bpp: Number.isFinite(bpp) && bpp > 0 ? bpp : null,
	};
	if (previewSettings.cursor_only === true) {
		throw new BrowserLocalExportUnavailable(
			"Cursor-only export uses the worker",
		);
	}
	const videoId = localVideoId(settings);
	const job = await exportJob(videoId, settings, new AbortController().signal);
	const state = exportWorker();
	const id = nextPreviewId++;
	const quality =
		Math.min(
			Math.max(((job.bitsPerPixel - 0.04) / (0.3 - 0.04)) * 55 + 40, 40),
			95,
		) / 100;
	const result = await new Promise<
		Extract<BrowserExportMessage, { kind: "preview" }>
	>((resolve, reject) => {
		const listener: WorkerListener = (message) => {
			if (message.kind === "preview" && message.id === id) {
				state.listeners.delete(listener);
				resolve(message);
			} else if (
				message.kind === "error" &&
				(message.id === id || message.id === undefined)
			) {
				state.listeners.delete(listener);
				reject(new BrowserLocalExportUnavailable(message.message));
			}
		};
		state.listeners.add(listener);
		state.worker.postMessage({
			kind: "preview",
			id,
			job,
			frameTime,
			jpegQuality: quality,
		});
	});
	const bytes = new Uint8Array(result.jpeg);
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	const durationSeconds = result.totalFrames / job.fps;
	return {
		jpeg_base64: btoa(binary),
		estimated_size_mb: estimatedSizeMb(job, durationSeconds),
		actual_width: result.width,
		actual_height: result.height,
		frame_render_time_ms: result.renderMs,
		total_frames: result.totalFrames,
	};
}

export async function browserLocalExportEstimates(
	settings: Record<string, unknown>,
) {
	const videoId = localVideoId(settings);
	const job = await exportJob(videoId, settings, new AbortController().signal);
	const module = await loadBrowserRenderer();
	const timeline = new module.BrowserTimeline(
		JSON.stringify(
			job.config.timeline ?? {
				segments: job.sourceDurations.map((duration, recordingSegment) => ({
					recordingSegment,
					timescale: 1,
					start: 0,
					end: duration,
				})),
				transitions: [],
				zoomSegments: [],
			},
		),
	);
	const durationSeconds = timeline.duration();
	timeline.free();
	const frames = Math.ceil(durationSeconds * job.fps);
	const pixels = job.resolutionBase.x * job.resolutionBase.y;
	const throughput = measuredThroughput() ?? 500_000_000;
	const seconds = (frames * pixels) / throughput + 1;
	const size = estimatedSizeMb(job, durationSeconds);
	return {
		duration_seconds: durationSeconds,
		estimated_time_seconds: seconds,
		estimated_size_mb: size,
		time_range_seconds: [seconds * 0.7, seconds * 1.4] as [number, number],
		size_range_mb: [size * 0.6, size * 1.5] as [number, number],
	};
}

/// Renders and encodes the export on this machine and saves it as a download.
/// Throws `BrowserLocalExportUnavailable` before any frame renders when the
/// browser cannot export locally, so the caller can use the worker instead.
export async function runBrowserLocalExport(
	settings: Record<string, unknown>,
	channelId: number | null,
	fileName: string,
) {
	const videoId = localVideoId(settings);
	if (activeExport)
		throw new Error("Finish or cancel the current editor export first");
	const job = await exportJob(videoId, settings, new AbortController().signal);
	const state = exportWorker();
	let started = false;
	let listener: WorkerListener = () => undefined;
	const result = await new Promise<
		Extract<BrowserExportMessage, { kind: "done" }>
	>((resolve, reject) => {
		activeExport = { reject };
		listener = (message) => {
			if (message.kind === "progress") {
				started = true;
				if (channelId !== null)
					emitEditorChannel(channelId, {
						type: "FramesRendered",
						renderedCount: message.renderedCount,
						totalFrames: message.totalFrames,
					});
			} else if (message.kind === "done") {
				resolve(message);
			} else if (message.kind === "error" && message.id === undefined) {
				reject(
					started
						? new Error(message.message)
						: new BrowserLocalExportUnavailable(message.message),
				);
			}
		};
		state.listeners.add(listener);
		state.worker.postMessage(job);
	}).finally(() => {
		state.listeners.delete(listener);
		activeExport = null;
	});
	console.info("Cap local export", JSON.stringify(result.stats));
	const seconds = result.stats.totalMs / 1000;
	if (seconds > 1)
		rememberThroughput(
			(result.stats.frames * result.stats.width * result.stats.height) /
				seconds,
		);
	download(result.data, result.mimeType, fileName);
	return fileName;
}
