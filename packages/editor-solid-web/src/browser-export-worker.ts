// Local MP4 export. Runs the same native render core as the preview on WebGPU
// in a worker: sources decode in presentation order with WebCodecs, frames
// render into an OffscreenCanvas and go straight to the hardware H.264
// encoder, so no pixels round-trip through the CPU.
import type { InputVideoTrack, VideoSample, VideoSampleSink } from "mediabunny";
import { renderBrowserExportAudio } from "./browser-export-audio";
import type { BrowserStudioSetup } from "./browser-local-canvas";

export type BrowserExportTrackSource = {
	display: string | null;
	camera: string | null;
};

export type BrowserExportAudioSource = {
	url: string;
	kind: "mic" | "system" | "display";
	segment: number;
	offsetSeconds: number;
};

export type BrowserExportJob = {
	kind: "export";
	config: Record<string, unknown>;
	setup: BrowserStudioSetup;
	studioMeta: unknown;
	sourceDurations: number[];
	tracks: BrowserExportTrackSource[];
	inputEventsUrl: string | null;
	audio: BrowserExportAudioSource[];
	musicUrls: Record<string, string>;
	assetUrls: Record<string, string>;
	fontUrls: string[];
	fps: number;
	resolutionBase: { x: number; y: number };
	bitsPerPixel: number;
};

export type BrowserExportPreviewRequest = {
	kind: "preview";
	id: number;
	job: BrowserExportJob;
	frameTime: number;
	jpegQuality: number;
};

export type BrowserExportMessage =
	| { kind: "progress"; renderedCount: number; totalFrames: number }
	| { kind: "done"; data: ArrayBuffer; mimeType: string; stats: ExportStats }
	| {
			kind: "preview";
			id: number;
			jpeg: ArrayBuffer;
			width: number;
			height: number;
			totalFrames: number;
			renderMs: number;
	  }
	| { kind: "error"; id?: number; message: string };

export type ExportStats = {
	frames: number;
	width: number;
	height: number;
	renderMs: number;
	decodeWaitMs: number;
	encodeWaitMs: number;
	totalMs: number;
	videoCodec: string;
	audioCodec: string | null;
};

type RendererModule =
	typeof import("../renderer/pkg-export/cap_editor_browser_renderer.js");

const scope = self as unknown as {
	addEventListener: (
		type: "message",
		listener: (
			event: MessageEvent<
				BrowserExportJob | BrowserExportPreviewRequest | { kind: "cancel" }
			>,
		) => void,
	) => void;
	postMessage: (
		message: BrowserExportMessage,
		transfer?: Transferable[],
	) => void;
};

let canceled = false;

function checkCanceled() {
	if (canceled) throw new Error("Export cancelled");
}

/// Native H.264 export bitrate: pixels per second (frame rates above 30 count
/// at 60%) times bits per pixel.
export function exportBitrate(
	width: number,
	height: number,
	fps: number,
	bitsPerPixel: number,
) {
	const frameRate = Math.max(fps - 30, 0) * 0.6 + 30;
	return Math.round(width * height * frameRate * bitsPerPixel);
}

type TrackCursor = {
	sink: VideoSampleSink;
	retagBt601: boolean;
	iterator: AsyncGenerator<VideoSample, void, unknown> | null;
	current: VideoSample | null;
	upcoming: VideoSample | null;
	dispose: () => void;
};

async function openCursor(url: string): Promise<TrackCursor | null> {
	const { ALL_FORMATS, Input, UrlSource, VideoSampleSink } = await import(
		"mediabunny"
	);
	const input = new Input({
		formats: ALL_FORMATS,
		source: new UrlSource(url, { maxCacheSize: 64 * 1024 * 1024 }),
	});
	const track: InputVideoTrack | null = await input.getPrimaryVideoTrack();
	if (!track) {
		input.dispose();
		return null;
	}
	const [width, height, config] = await Promise.all([
		track.getDisplayWidth(),
		track.getDisplayHeight(),
		track.getDecoderConfig(),
	]);
	const cursor: TrackCursor = {
		sink: new VideoSampleSink(track),
		retagBt601:
			!!config &&
			config.codec.startsWith("avc1") &&
			config.colorSpace === undefined &&
			width <= 720 &&
			height <= 576,
		iterator: null,
		current: null,
		upcoming: null,
		dispose: () => {
			void resetCursor(cursor).finally(() => input.dispose());
		},
	};
	return cursor;
}

async function resetCursor(cursor: TrackCursor) {
	const iterator = cursor.iterator;
	cursor.iterator = null;
	cursor.current?.close();
	cursor.current = null;
	cursor.upcoming?.close();
	cursor.upcoming = null;
	if (iterator) await iterator.return();
}

/// The latest sample at or before `time`, matching the preview's decoded
/// frame choice. Streams forward; restarts only on a backwards or long jump.
async function sampleAt(cursor: TrackCursor, time: number) {
	const epsilon = 0.000001;
	if (
		cursor.iterator &&
		cursor.current &&
		(time + epsilon < cursor.current.timestamp ||
			time > cursor.current.timestamp + 2)
	) {
		await resetCursor(cursor);
	}
	if (!cursor.iterator) {
		cursor.iterator = cursor.sink.samples(Math.max(time, 0.0001));
		const first = await cursor.iterator.next();
		if (first.done) return null;
		cursor.current = first.value;
	}
	if (!cursor.current) return null;
	while (time > cursor.current.timestamp + epsilon) {
		if (!cursor.upcoming) {
			const next = await cursor.iterator.next();
			if (next.done) break;
			cursor.upcoming = next.value;
		}
		if (cursor.upcoming.timestamp > time + epsilon) break;
		cursor.current.close();
		cursor.current = cursor.upcoming;
		cursor.upcoming = null;
	}
	return cursor.current;
}

async function frameFor(cursor: TrackCursor, time: number) {
	const sample = await sampleAt(cursor, time);
	if (!sample) return null;
	const frame = sample.toVideoFrame();
	if (
		!cursor.retagBt601 ||
		frame.colorSpace.matrix === "bt470bg" ||
		(frame.format !== "I420" && frame.format !== "NV12")
	) {
		return frame;
	}
	const pixels = new Uint8Array(frame.allocationSize());
	const layout = await frame.copyTo(pixels);
	const tagged = new VideoFrame(pixels, {
		format: frame.format,
		codedWidth: frame.codedWidth,
		codedHeight: frame.codedHeight,
		timestamp: frame.timestamp,
		layout,
		colorSpace: {
			primaries: "bt709",
			transfer: "bt709",
			matrix: "bt470bg",
			fullRange: false,
		},
	});
	frame.close();
	return tagged;
}

async function loadModule(): Promise<RendererModule> {
	const module = await import(
		"../renderer/pkg-export/cap_editor_browser_renderer.js"
	);
	await module.default();
	return module;
}

async function fetchBytes(url: string) {
	const response = await fetch(url, { credentials: "same-origin" });
	if (!response.ok) throw new Error("Export asset could not load");
	return new Uint8Array(await response.arrayBuffer());
}

type Renderer =
	import("../renderer/pkg-export/cap_editor_browser_renderer.js").BrowserStudioRenderer;

type ClipFrames = { display: VideoFrame; camera: VideoFrame | null };

/// Everything needed to render any output frame of one export configuration.
type RenderContext = {
	key: string;
	module: RendererModule;
	renderer: Renderer;
	canvas: OffscreenCanvas;
	width: number;
	height: number;
	totalFrames: number;
	timeline: InstanceType<RendererModule["BrowserTimeline"]>;
	times: InstanceType<RendererModule["BrowserRecordingTimes"]>;
	clipFrames: (
		clip: number,
		sourceTime: number,
		role: string,
	) => Promise<ClipFrames>;
	dispose: () => void;
};

let modulePromise: Promise<RendererModule> | null = null;
const registeredAssets = new Set<string>();
let fontsRegistered = false;
let inputRegistered: string | null = null;
let cachedContext: RenderContext | null = null;

async function prepareAssets(module: RendererModule, job: BrowserExportJob) {
	await Promise.all([
		...Object.entries(job.assetUrls).map(async ([path, url]) => {
			if (registeredAssets.has(path) || module.has_asset(path)) return;
			module.register_asset(path, await fetchBytes(url));
			registeredAssets.add(path);
		}),
		job.fontUrls.length > 0 && !fontsRegistered
			? Promise.all(job.fontUrls.map(fetchBytes)).then((fonts) => {
					for (const font of fonts) module.register_font(font);
					fontsRegistered = true;
				})
			: undefined,
		job.inputEventsUrl && inputRegistered !== job.inputEventsUrl
			? fetch(job.inputEventsUrl)
					.then((response) => (response.ok ? response.text() : null))
					.then((text) => {
						if (text) module.web_input_recording(text);
						inputRegistered = job.inputEventsUrl;
					})
					.catch(() => undefined)
			: undefined,
	]);
}

function contextKey(job: BrowserExportJob) {
	return JSON.stringify([
		job.config,
		job.setup,
		job.tracks,
		job.fps,
		job.resolutionBase,
	]);
}

async function renderContext(job: BrowserExportJob): Promise<RenderContext> {
	const key = contextKey(job);
	if (cachedContext?.key === key) return cachedContext;
	cachedContext?.dispose();
	cachedContext = null;
	if (!modulePromise) modulePromise = loadModule();
	const module = await modulePromise;
	await prepareAssets(module, job);
	const timelineConfig = job.config.timeline ?? {
		segments: job.sourceDurations.map((duration, recordingSegment) => ({
			recordingSegment,
			timescale: 1,
			start: 0,
			end: duration,
		})),
		transitions: [],
		zoomSegments: [],
	};
	const config = { ...job.config, timeline: timelineConfig };
	const timeline = new module.BrowserTimeline(JSON.stringify(timelineConfig));
	const times = new module.BrowserRecordingTimes(
		JSON.stringify(job.studioMeta),
		JSON.stringify(job.config.clips ?? []),
	);
	const cursors = new Map<string, Promise<TrackCursor | null>>();
	let renderer: Renderer | null = null;
	const dispose = () => {
		for (const cursor of cursors.values())
			void cursor.then(
				(value) => value?.dispose(),
				() => undefined,
			);
		cursors.clear();
		renderer?.free();
		renderer = null;
		timeline.free();
		times.free();
	};
	try {
		const visual = new module.BrowserVisualConfig(JSON.stringify(config));
		const [width = 0, height = 0] = visual.output_dimensions(
			job.setup.screenWidth,
			job.setup.screenHeight,
			job.resolutionBase.x,
			job.resolutionBase.y,
		);
		visual.free();
		const canvas = new OffscreenCanvas(width, height);
		const created = await module.BrowserStudioRenderer.create(
			canvas,
			true,
			JSON.stringify(job.setup.recordingMeta),
			job.setup.screenWidth,
			job.setup.screenHeight,
			job.setup.cameraWidth,
			job.setup.cameraHeight,
		);
		renderer = created;
		job.setup.cursors.forEach((cursor, index) => {
			if (cursor) created.set_cursor(index, cursor);
		});
		created.set_project(JSON.stringify(config));
		const cursorFor = (
			clip: number,
			track: "display" | "camera",
			role: string,
		) => {
			const key = `${clip}:${track}:${role}`;
			let cursor = cursors.get(key);
			if (!cursor) {
				const url = job.tracks[clip]?.[track] ?? null;
				cursor = url ? openCursor(url) : Promise.resolve(null);
				cursors.set(key, cursor);
			}
			return cursor;
		};
		const clipFrames = async (
			clip: number,
			sourceTime: number,
			role: string,
		) => {
			const sourceTimes = times.source_times(clip, sourceTime);
			const displayTime = Math.max(0, sourceTimes[0] ?? 0);
			const cameraTime = sourceTimes[1] ?? Number.NaN;
			const [display, camera] = await Promise.all([
				cursorFor(clip, "display", role).then((cursor) =>
					cursor ? frameFor(cursor, displayTime) : null,
				),
				Number.isFinite(cameraTime) && cameraTime >= 0
					? cursorFor(clip, "camera", role).then((cursor) =>
							cursor ? frameFor(cursor, cameraTime) : null,
						)
					: Promise.resolve(null),
			]);
			if (!display) {
				camera?.close();
				throw new Error("Export display video is unavailable");
			}
			return { display, camera };
		};
		const context: RenderContext = {
			key,
			module,
			renderer: created,
			canvas,
			width,
			height,
			totalFrames: Math.ceil(job.fps * timeline.duration()),
			timeline,
			times,
			clipFrames,
			dispose,
		};
		cachedContext = context;
		return context;
	} catch (cause) {
		dispose();
		throw cause;
	}
}

type DecodedFrame = {
	mapped: Float64Array | number[];
	incoming: ClipFrames;
	outgoing: ClipFrames | null;
};

function release(item: DecodedFrame | null) {
	item?.incoming.display.close();
	item?.incoming.camera?.close();
	item?.outgoing?.display.close();
	item?.outgoing?.camera?.close();
}

async function decodeFrame(
	context: RenderContext,
	fps: number,
	frame: number,
): Promise<DecodedFrame | null> {
	const mapped = context.timeline.map_frame(frame / fps);
	if (mapped.length !== 11) return null;
	const incoming = await context.clipFrames(
		mapped[2] ?? 0,
		mapped[3] ?? 0,
		"primary",
	);
	if (mapped[0] !== 2) return { mapped, incoming, outgoing: null };
	try {
		const outgoing = await context.clipFrames(
			mapped[5] ?? 0,
			mapped[6] ?? 0,
			"overlap",
		);
		return { mapped, incoming, outgoing };
	} catch (cause) {
		incoming.display.close();
		incoming.camera?.close();
		throw cause;
	}
}

function renderDecoded(
	context: RenderContext,
	job: BrowserExportJob,
	frame: number,
	item: DecodedFrame,
) {
	const { mapped, incoming, outgoing } = item;
	try {
		if (outgoing) {
			context.renderer.render_transition(
				frame,
				job.fps,
				job.resolutionBase.x,
				job.resolutionBase.y,
				mapped[5] ?? 0,
				mapped[6] ?? 0,
				outgoing.display,
				false,
				outgoing.camera,
				false,
				mapped[2] ?? 0,
				mapped[3] ?? 0,
				incoming.display,
				false,
				incoming.camera,
				false,
				mapped[8] ?? 0,
				mapped[9] ?? 0,
			);
		} else {
			context.renderer.render(
				frame,
				job.fps,
				job.resolutionBase.x,
				job.resolutionBase.y,
				mapped[2] ?? 0,
				mapped[3] ?? 0,
				incoming.display,
				false,
				incoming.camera,
				false,
			);
		}
	} finally {
		release(item);
	}
}

async function runPreview(request: BrowserExportPreviewRequest) {
	const context = await renderContext(request.job);
	const started = performance.now();
	const lastFrame = Math.max(context.totalFrames - 1, 0);
	const frame = Math.min(
		Math.max(Math.round(request.frameTime * request.job.fps), 0),
		lastFrame,
	);
	const item = await decodeFrame(context, request.job.fps, frame);
	if (!item) throw new Error("Export preview frame is unavailable");
	renderDecoded(context, request.job, frame, item);
	const blob = await context.canvas.convertToBlob({
		type: "image/jpeg",
		quality: request.jpegQuality,
	});
	const jpeg = await blob.arrayBuffer();
	scope.postMessage(
		{
			kind: "preview",
			id: request.id,
			jpeg,
			width: context.width,
			height: context.height,
			totalFrames: context.totalFrames,
			renderMs: performance.now() - started,
		},
		[jpeg],
	);
}

async function runExport(job: BrowserExportJob) {
	const started = performance.now();
	const context = await renderContext(job);
	checkCanceled();
	const { canvas, width, height, totalFrames, times } = context;
	const {
		BufferTarget,
		CanvasSource,
		Mp4OutputFormat,
		Output,
		canEncodeVideo,
	} = await import("mediabunny");
	const bitrate = exportBitrate(width, height, job.fps, job.bitsPerPixel);
	if (!(await canEncodeVideo("avc", { width, height, bitrate }))) {
		throw new Error("This browser cannot encode H.264 video");
	}
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: "in-memory" }),
		target: new BufferTarget(),
	});
	const videoSource = new CanvasSource(canvas, {
		codec: "avc",
		bitrate,
		keyFrameInterval: 2,
		latencyMode: "quality",
		hardwareAcceleration: "prefer-hardware",
	});
	output.addVideoTrack(videoSource, { frameRate: job.fps });
	const audio = await renderBrowserExportAudio(job, times, output, totalFrames);
	await output.start();
	const audioDone = audio?.run() ?? Promise.resolve();

	// Frame N renders and is handed to the encoder (which captures the canvas
	// synchronously), then frame N+1 decodes while N encodes.
	let renderMs = 0;
	let decodeWaitMs = 0;
	let encodeWaitMs = 0;
	let lastProgress = 0;
	let pendingDecode: Promise<DecodedFrame | null> = decodeFrame(
		context,
		job.fps,
		0,
	);
	let pendingEncode: Promise<void> = Promise.resolve();
	try {
		for (let frame = 0; frame < totalFrames; frame++) {
			checkCanceled();
			const decodeStart = performance.now();
			const item = await pendingDecode;
			decodeWaitMs += performance.now() - decodeStart;
			if (!item) break;
			const renderStart = performance.now();
			renderDecoded(context, job, frame, item);
			renderMs += performance.now() - renderStart;
			const encodeStart = performance.now();
			await pendingEncode;
			encodeWaitMs += performance.now() - encodeStart;
			pendingEncode = videoSource.add(frame / job.fps, 1 / job.fps);
			pendingDecode =
				frame + 1 < totalFrames
					? decodeFrame(context, job.fps, frame + 1)
					: Promise.resolve(null);
			const now = performance.now();
			if (now - lastProgress > 100 || frame + 1 === totalFrames) {
				lastProgress = now;
				scope.postMessage({
					kind: "progress",
					renderedCount: frame + 1,
					totalFrames,
				});
			}
		}
		await pendingEncode;
	} catch (cause) {
		void pendingDecode.then(release, () => undefined);
		throw cause;
	}
	checkCanceled();
	videoSource.close();
	await audioDone;
	await output.finalize();
	const buffer = output.target.buffer;
	if (!buffer) throw new Error("Export produced no file");
	scope.postMessage(
		{
			kind: "done",
			data: buffer,
			mimeType: "video/mp4",
			stats: {
				frames: totalFrames,
				width,
				height,
				renderMs: Math.round(renderMs),
				decodeWaitMs: Math.round(decodeWaitMs),
				encodeWaitMs: Math.round(encodeWaitMs),
				totalMs: Math.round(performance.now() - started),
				videoCodec: "avc",
				audioCodec: audio?.codec ?? null,
			},
		},
		[buffer],
	);
}

// Jobs share one render context, so they run one at a time; a preview that
// a newer preview superseded while queued is skipped.
let queue: Promise<void> = Promise.resolve();
let latestPreview = 0;

function enqueue(run: () => Promise<void>) {
	queue = queue.then(run, run).catch(() => undefined);
}

scope.addEventListener("message", (event) => {
	const message = event.data;
	if (message.kind === "cancel") {
		canceled = true;
		return;
	}
	if (message.kind === "preview") {
		latestPreview = message.id;
		enqueue(async () => {
			if (message.id !== latestPreview) {
				scope.postMessage({
					kind: "error",
					id: message.id,
					message: "Export preview was superseded",
				});
				return;
			}
			await runPreview(message).catch((cause: unknown) => {
				scope.postMessage({
					kind: "error",
					id: message.id,
					message: cause instanceof Error ? cause.message : String(cause),
				});
			});
		});
		return;
	}
	if (message.kind !== "export") return;
	enqueue(async () => {
		canceled = false;
		await runExport(message).catch((cause: unknown) => {
			scope.postMessage({
				kind: "error",
				message: cause instanceof Error ? cause.message : String(cause),
			});
		});
	});
});
