import {
	type ExportBitrateSample,
	exportBitrateSample,
	exportSizeRangeMb,
} from "./browser-export-estimate";
import {
	exportDirectory,
	holdExportFile,
	newExportFileName,
	removeUnusedExportFiles,
} from "./browser-export-storage";
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

export function browserLocalExportSupported() {
	return (
		typeof Worker === "function" &&
		typeof OffscreenCanvas === "function" &&
		typeof VideoEncoder === "function" &&
		typeof VideoDecoder === "function" &&
		typeof AudioEncoder === "function" &&
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

/// Starts the export worker and its renderer module ahead of a first export
/// or browser save, so it doesn't wait on them.
export function prewarmBrowserLocalExport() {
	if (browserLocalExportSupported()) exportWorker();
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
	// The preview holds the editor's reactive project store, which a worker
	// cannot be sent; the job carries a plain copy.
	const live = browserEditorPreviewConfig();
	const config = record(live == null ? null : JSON.parse(JSON.stringify(live)));
	if (!config)
		throw new BrowserLocalExportUnavailable("Editor project is loading");
	const catalog = new BrowserEditorSourceCatalog(videoId, { fresh: true });
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
			outputFile: "",
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

/// A streamed export stays in the origin private file system until the
/// browser has copied it to the downloads folder. The page learns nothing of
/// when that is: removing it any sooner cancels a download still copying, or
/// one waiting on the user to choose where to save it. If the tab closes
/// first, the next editor or export removes it.
const STORED_EXPORT_LIFETIME_MS = 10 * 60_000;

/// Locks held on this page's export files; see `browser-export-storage`.
const heldExportFiles = new Map<string, () => void>();

export function discardStoredBrowserExport(storedFile: string | null) {
	if (!storedFile) return;
	const release = heldExportFiles.get(storedFile);
	heldExportFiles.delete(storedFile);
	void exportDirectory()
		.then((root) => root.removeEntry(storedFile))
		.catch(() => undefined)
		.finally(() => release?.());
}

/// Removes export files that earlier tabs left behind, once the editor opens.
export function removeLeftoverBrowserExports() {
	void exportDirectory()
		.then((root) => removeUnusedExportFiles(root))
		.catch(() => undefined);
}

function download(data: Blob, fileName: string, storedFile: string | null) {
	const url = URL.createObjectURL(data);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	link.style.display = "none";
	document.body.append(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
	if (storedFile)
		window.setTimeout(
			() => discardStoredBrowserExport(storedFile),
			STORED_EXPORT_LIFETIME_MS,
		);
}

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

const BITRATE_KEY = "cap-web-editor-export-bitrate";

function bitrateSamples(): Record<string, ExportBitrateSample> {
	try {
		return (
			(record(
				JSON.parse(window.localStorage.getItem(BITRATE_KEY) ?? "{}"),
			) as Record<string, ExportBitrateSample> | null) ?? {}
		);
	} catch {
		return {};
	}
}

function previousBitrate(videoId: string): ExportBitrateSample | null {
	const sample = record(bitrateSamples()[videoId]);
	return sample &&
		[sample.bitrate, sample.target, sample.pixelRate].every(
			(value) => typeof value === "number" && Number.isFinite(value),
		)
		? (sample as ExportBitrateSample)
		: null;
}

function rememberBitrate(videoId: string, sample: ExportBitrateSample) {
	const samples = bitrateSamples();
	delete samples[videoId];
	samples[videoId] = sample;
	try {
		window.localStorage.setItem(
			BITRATE_KEY,
			JSON.stringify(Object.fromEntries(Object.entries(samples).slice(-50))),
		);
	} catch {}
}

async function outputSize(job: BrowserExportJob) {
	const module = await loadBrowserRenderer();
	const visual = new module.BrowserVisualConfig(JSON.stringify(job.config));
	try {
		const [width = job.resolutionBase.x, height = job.resolutionBase.y] =
			visual.output_dimensions(
				job.setup.screenWidth,
				job.setup.screenHeight,
				job.resolutionBase.x,
				job.resolutionBase.y,
			);
		return { width, height };
	} finally {
		visual.free();
	}
}

function sizeRangeMb(
	videoId: string,
	job: BrowserExportJob,
	width: number,
	height: number,
	durationSeconds: number,
) {
	return exportSizeRangeMb({
		width,
		height,
		fps: job.fps,
		bitsPerPixel: job.bitsPerPixel,
		durationSeconds,
		previous: previousBitrate(videoId),
	});
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
	exportWorker();
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
	const [smallest, largest] = sizeRangeMb(
		videoId,
		job,
		result.width,
		result.height,
		result.totalFrames / job.fps,
	);
	return {
		jpeg_base64: btoa(binary),
		estimated_size_mb: (smallest + largest) / 2,
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
	const { width, height } = await outputSize(job);
	const throughput = measuredThroughput() ?? 500_000_000;
	const seconds = (frames * width * height) / throughput + 1;
	const sizeRange = sizeRangeMb(videoId, job, width, height, durationSeconds);
	return {
		duration_seconds: durationSeconds,
		estimated_time_seconds: seconds,
		estimated_size_mb: (sizeRange[0] + sizeRange[1]) / 2,
		time_range_seconds: [seconds * 0.7, seconds * 1.4] as [number, number],
		size_range_mb: sizeRange,
	};
}

/// Renders and encodes the export on this machine. Throws
/// `BrowserLocalExportUnavailable` before any frame renders when the browser
/// cannot export locally, so the caller can use the worker instead.
export async function renderBrowserLocalExport(
	settings: Record<string, unknown>,
	onProgress?: (renderedCount: number, totalFrames: number) => void,
) {
	const videoId = localVideoId(settings);
	if (activeExport)
		throw new Error("Finish or cancel the current editor export first");
	const controller = new AbortController();
	let cancel: (error: Error) => void = () => undefined;
	const cancelled = new Promise<never>((_, reject) => {
		cancel = reject;
	});
	cancelled.catch(() => undefined);
	const current = {
		reject: (error: Error) => {
			controller.abort();
			cancel(error);
		},
	};
	activeExport = current;
	const state = { listener: (() => undefined) as WorkerListener };
	let worker: ReturnType<typeof exportWorker> | null = null;
	let job: BrowserExportJob | undefined;
	let result: Extract<BrowserExportMessage, { kind: "done" }>;
	try {
		exportWorker();
		job = await Promise.race([
			exportJob(videoId, settings, controller.signal),
			cancelled,
		]);
		job.outputFile = newExportFileName();
		const release = await holdExportFile(job.outputFile);
		if (release) heldExportFiles.set(job.outputFile, release);
		worker = exportWorker();
		result = await Promise.race([
			workerExport(worker, job, state, onProgress),
			cancelled,
		]);
	} catch (cause) {
		discardStoredBrowserExport(job?.outputFile ?? null);
		throw cause;
	} finally {
		worker?.listeners.delete(state.listener);
		if (activeExport === current) activeExport = null;
	}
	// Built in memory for want of room: the file it would have used is empty.
	if (result.storedFile !== job.outputFile)
		discardStoredBrowserExport(job.outputFile);
	console.info("Cap local export", JSON.stringify(result.stats));
	const seconds = result.stats.totalMs / 1000;
	if (seconds > 1)
		rememberThroughput(
			(result.stats.frames * result.stats.width * result.stats.height) /
				seconds,
		);
	const duration = result.stats.frames / job.fps;
	const sample = exportBitrateSample(
		result.data.size,
		duration,
		result.stats.width,
		result.stats.height,
		job.fps,
		job.bitsPerPixel,
	);
	if (sample) rememberBitrate(videoId, sample);
	return {
		data: result.data,
		storedFile: result.storedFile,
		mimeType: result.mimeType,
		width: result.stats.width,
		height: result.stats.height,
		fps: job.fps,
		duration,
	};
}

function workerExport(
	worker: ReturnType<typeof exportWorker>,
	job: BrowserExportJob,
	state: { listener: WorkerListener },
	onProgress?: (renderedCount: number, totalFrames: number) => void,
) {
	let started = false;
	return new Promise<Extract<BrowserExportMessage, { kind: "done" }>>(
		(resolve, reject) => {
			state.listener = (message) => {
				if (message.kind === "progress") {
					started = true;
					onProgress?.(message.renderedCount, message.totalFrames);
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
			worker.listeners.add(state.listener);
			worker.worker.postMessage(job);
		},
	);
}

export async function runBrowserLocalExport(
	settings: Record<string, unknown>,
	channelId: number | null,
	fileName: string,
) {
	const result = await renderBrowserLocalExport(
		settings,
		(renderedCount, totalFrames) => {
			if (channelId !== null)
				emitEditorChannel(channelId, {
					type: "FramesRendered",
					renderedCount,
					totalFrames,
				});
		},
	);
	download(result.data, fileName, result.storedFile);
	return fileName;
}
