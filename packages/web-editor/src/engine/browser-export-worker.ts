import type {
	EncodedPacket,
	InputVideoTrack,
	VideoSample,
	VideoSampleSink,
} from "mediabunny";
import {
	decodeAudioLevels,
	hasWaveformSegments,
	loadAudioLevels,
	timelineAudioLevelSources,
} from "./browser-audio-levels";
import { renderBrowserExportAudio } from "./browser-export-audio";
import {
	avcCodecString,
	ExportEncoder,
	keyframeGroup,
	pixelsLookBlack,
	supportedEncoderConfig,
} from "./browser-export-encoder";
import { EXPORT_AUDIO_BITRATE, exportBitrate } from "./browser-export-estimate";
import {
	exportDirectory,
	removeUnusedExportFiles,
} from "./browser-export-storage";
import type { BrowserStudioSetup } from "./browser-local-canvas";
import {
	type Nv12Planes,
	nv12Planes,
	takesNv12Planes,
	UPLOADS_NV12_PLANES,
} from "./browser-nv12-planes";
import {
	EXPORT_ASSET_FAILED,
	isMissingEditorImage,
	MISSING_EDITOR_IMAGE,
} from "./editor-image-missing";
import {
	isSourceUrlRenewReply,
	parentSourceUrlRenewer,
	type SourceUrlRenewReply,
	type SourceUrlRenewRequest,
} from "./source-url-renewal";

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
	sourcesExpireAt: number | null;
	musicUrls: Record<string, string>;
	assetUrls: Record<string, string>;
	/// Style backgrounds: the renderer draws a plain background in place of
	/// one that fails to load, as the preview does, so the export goes on.
	optionalAssetUrls?: Record<string, string>;
	fontUrls: string[];
	fps: number;
	webGpu: boolean;
	resolutionBase: { x: number; y: number };
	bitsPerPixel: number;
	outputFile: string;
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
	| {
			kind: "done";
			data: Blob;
			storedFile: string | null;
			mimeType: string;
			stats: ExportStats;
	  }
	| {
			kind: "preview";
			id: number;
			jpeg: ArrayBuffer;
			width: number;
			height: number;
			totalFrames: number;
			renderMs: number;
	  }
	| { kind: "error"; id?: number; message: string }
	| SourceUrlRenewRequest;

export type ExportStats = {
	frames: number;
	width: number;
	height: number;
	renderMs: number;
	decodeWaitMs: number;
	encodeWaitMs: number;
	captureMs: number;
	totalMs: number;
	videoCodec: string;
	encoderAcceleration: string;
	audioCodec: string | null;
	backend: string;
	webGpuFailover: boolean;
};

type RendererModule =
	typeof import("../../renderer/pkg-export/cap_editor_browser_renderer.js");

const scope = self as unknown as {
	addEventListener: (
		type: "message",
		listener: (
			event: MessageEvent<
				| BrowserExportJob
				| BrowserExportPreviewRequest
				| { kind: "cancel" }
				| SourceUrlRenewReply
			>,
		) => void,
	) => void;
	postMessage: (
		message: BrowserExportMessage,
		transfer?: Transferable[],
	) => void;
};

let canceled = false;

const { renewer: sourceUrls, answer: answerSourceUrl } =
	parentSourceUrlRenewer(scope);

function checkCanceled() {
	if (canceled) throw new Error("Export cancelled");
}

// Chrome colour-manages hardware-decoded frames when they're copied into a
// texture: BT.709 video comes out re-encoded for an sRGB display (brighter
// shadows), where the native renderer and Safari apply the plain YUV to RGB
// matrix. Frames Chrome decodes in software keep their plain values.
const COLOR_MANAGES_HARDWARE_FRAMES = /Chrome|Chromium|Edg/.test(
	navigator.userAgent,
);

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
		source: new UrlSource(
			url,
			sourceUrls.urlSourceOptions(url, 64 * 1024 * 1024),
		),
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
		sink: new VideoSampleSink(
			track,
			COLOR_MANAGES_HARDWARE_FRAMES
				? { hardwareAcceleration: "prefer-software" }
				: undefined,
		),
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

type ExportFrame = VideoFrame | Nv12Planes;

async function frameFor(
	cursor: TrackCursor,
	time: number,
	planes: boolean,
): Promise<ExportFrame | null> {
	const sample = await sampleAt(cursor, time);
	if (!sample) return null;
	const frame = sample.toVideoFrame();
	if (planes && !cursor.retagBt601 && takesNv12Planes(frame)) {
		const copied = await nv12Planes(frame, true).catch(() => null);
		if (copied) {
			frame.close();
			return copied;
		}
	}
	if (
		!cursor.retagBt601 ||
		frame.colorSpace.matrix === "bt470bg" ||
		(frame.format !== "I420" && frame.format !== "NV12")
	) {
		return frame;
	}
	// copyTo copies the visible rect, which is smaller than the coded size
	// when the decoder pads it (640x360 H.264 decodes to 640x368).
	const pixels = new Uint8Array(frame.allocationSize());
	const layout = await frame.copyTo(pixels);
	const tagged = new VideoFrame(pixels, {
		format: frame.format,
		codedWidth: frame.visibleRect?.width ?? frame.codedWidth,
		codedHeight: frame.visibleRect?.height ?? frame.codedHeight,
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
		"../../renderer/pkg-export/cap_editor_browser_renderer.js"
	);
	await module.default();
	return module;
}

async function fetchBytes(url: string) {
	const response = await fetch(url, { credentials: "same-origin" });
	if (response.status === 410) throw new Error(MISSING_EDITOR_IMAGE);
	if (!response.ok) throw new Error(EXPORT_ASSET_FAILED);
	return new Uint8Array(await response.arrayBuffer());
}

type Renderer =
	import("../../renderer/pkg-export/cap_editor_browser_renderer.js").BrowserStudioRenderer;

type ClipFrames = { display: ExportFrame; camera: ExportFrame | null };

type RenderContext = {
	key: string;
	module: RendererModule;
	renderer: Renderer;
	canvas: OffscreenCanvas;
	checked: boolean;
	failedOver: boolean;
	useWebGl2: () => Promise<void>;
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

function rendererModule() {
	modulePromise ??= loadModule().catch((cause: unknown) => {
		modulePromise = null;
		throw cause;
	});
	return modulePromise;
}

async function prepareAssets(module: RendererModule, job: BrowserExportJob) {
	await Promise.all([
		...Object.entries(job.assetUrls).map(async ([path, url]) => {
			if (registeredAssets.has(path) || module.has_asset(path)) return;
			try {
				module.register_asset(path, await fetchBytes(url));
				registeredAssets.add(path);
			} catch (cause) {
				if (!isMissingEditorImage(cause)) throw cause;
				console.warn("Export image is gone from storage:", path);
			}
		}),
		...Object.entries(job.optionalAssetUrls ?? {}).map(async ([path, url]) => {
			if (registeredAssets.has(path) || module.has_asset(path)) return;
			try {
				module.register_asset(path, await fetchBytes(url));
				registeredAssets.add(path);
			} catch (cause) {
				console.warn("Export style background could not load:", path, cause);
			}
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
		job.webGpu,
		job.resolutionBase,
	]);
}

const audioLevels = new Map<string, Promise<Uint8Array | null>>();

function workerAudioLevels(module: RendererModule, url: string) {
	let levels = audioLevels.get(url);
	if (!levels) {
		levels = decodeAudioLevels(module, url);
		audioLevels.set(url, levels);
		levels.catch(() => audioLevels.delete(url));
	}
	return levels;
}

async function renderContext(job: BrowserExportJob): Promise<RenderContext> {
	const key = contextKey(job);
	sourceUrls.expiresAt = job.sourcesExpireAt;
	if (cachedContext?.key === key) return cachedContext;
	cachedContext?.dispose();
	cachedContext = null;
	const module = await rendererModule();
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
		const createRenderer = async (webGpu: boolean) => {
			const canvas = new OffscreenCanvas(width, height);
			const created = await module.BrowserStudioRenderer.create(
				canvas,
				webGpu,
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
			if (hasWaveformSegments(config)) {
				await loadAudioLevels(
					module,
					() => created,
					[
						...job.audio,
						...timelineAudioLevelSources(config, (path) => job.musicUrls[path]),
					],
					(url) => workerAudioLevels(module, url),
				);
			}
			return { created, canvas };
		};
		const first = await createRenderer(job.webGpu);
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
			const planes =
				UPLOADS_NV12_PLANES && context.renderer.backend === "BrowserWebGpu";
			const sourceTimes = times.source_times(clip, sourceTime);
			const displayTime = Math.max(0, sourceTimes[0] ?? 0);
			const cameraTime = sourceTimes[1] ?? Number.NaN;
			const [display, camera] = await Promise.all([
				cursorFor(clip, "display", role).then((cursor) =>
					cursor ? frameFor(cursor, displayTime, planes) : null,
				),
				Number.isFinite(cameraTime) && cameraTime >= 0
					? cursorFor(clip, "camera", role).then((cursor) =>
							cursor ? frameFor(cursor, cameraTime, planes) : null,
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
			renderer: first.created,
			canvas: first.canvas,
			checked: false,
			failedOver: false,
			useWebGl2: async () => {
				context.renderer.free();
				renderer = null;
				try {
					const fallback = await createRenderer(false);
					context.renderer = fallback.created;
					context.canvas = fallback.canvas;
					context.failedOver = true;
				} catch (cause) {
					if (cachedContext === context) cachedContext = null;
					dispose();
					throw cause;
				}
			},
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

function canvasLooksBlack(canvas: OffscreenCanvas) {
	const frame = new VideoFrame(canvas, { timestamp: 0 });
	try {
		const sample = new OffscreenCanvas(64, 36);
		const context = sample.getContext("2d", { willReadFrequently: true });
		if (!context) return false;
		context.drawImage(frame, 0, 0, sample.width, sample.height);
		return pixelsLookBlack(
			context.getImageData(0, 0, sample.width, sample.height).data,
		);
	} finally {
		frame.close();
	}
}

// Chrome's software WebGPU adapter (SwiftShader) can render every frame black
// where the preview, which turns that adapter down, looks right. The first
// frame rendered is checked once, and drawn again on WebGL2 if it is black.
async function renderFrame(
	context: RenderContext,
	job: BrowserExportJob,
	frame: number,
	item: DecodedFrame,
) {
	renderDecoded(context, job, frame, item);
	if (context.checked) return;
	context.checked = true;
	if (
		context.renderer.backend !== "BrowserWebGpu" ||
		!canvasLooksBlack(context.canvas)
	)
		return;
	await context.useWebGl2();
	const again = await decodeFrame(context, job.fps, frame);
	if (!again) throw new Error("Export frame is unavailable");
	renderDecoded(context, job, frame, again);
	console.warn(
		"Cap export rendered black on WebGPU",
		JSON.stringify({ frame, webGl2Black: canvasLooksBlack(context.canvas) }),
	);
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
	await renderFrame(context, request.job, frame, item);
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

type SyncAccessHandle = {
	write(data: BufferSource, options: { at: number }): number;
	flush(): void;
	close(): void;
};

async function openExportFile(maxBytes: number, name: string) {
	if (!name) return null;
	try {
		const root = await exportDirectory();
		await removeUnusedExportFiles(root);
		const { quota = 0, usage = 0 } = await navigator.storage.estimate();
		if (quota - usage < maxBytes * 1.2) return null;
		const handle = await root.getFileHandle(name, { create: true });
		const access: SyncAccessHandle = await (
			handle as FileSystemFileHandle & {
				createSyncAccessHandle(): Promise<SyncAccessHandle>;
			}
		).createSyncAccessHandle();
		const { StreamTarget } = await import("mediabunny");
		return {
			name,
			target: new StreamTarget(
				new WritableStream({
					write(chunk) {
						// Past the storage quota a write can stop short without failing.
						if (
							access.write(chunk.data, { at: chunk.position }) <
							chunk.data.byteLength
						) {
							throw new Error(
								"There isn't enough free storage in this browser for the export",
							);
						}
					},
				}),
				{ chunked: true, chunkSize: 4 * 1024 * 1024 },
			),
			async finish() {
				access.flush();
				access.close();
				return handle.getFile();
			},
			discard() {
				access.close();
				void root.removeEntry(name).catch(() => undefined);
			},
		};
	} catch {
		return null;
	}
}

// Safari's H.264 encoder holds frames in quality mode until more arrive,
// while the export sends the next frame only once the last is encoded.
const HOLDS_QUALITY_FRAMES =
	/AppleWebKit/.test(navigator.userAgent) &&
	!/Chrome|Chromium|Edg/.test(navigator.userAgent);

// Safari's realtime encoder, fed faster than real time, silently drops
// frames after keyframes that come every few seconds; one every five seconds
// keeps them all.
const KEYFRAME_SECONDS = HOLDS_QUALITY_FRAMES ? 5 : 2;

// The same encoder spends fewer bits the faster frames arrive; asking for
// more keeps its quality where it was at the slower pace, at about the same
// file size.
const BITRATE_SCALE = HOLDS_QUALITY_FRAMES ? 1.35 : 1;

type LoopTimings = {
	renderMs: number;
	decodeWaitMs: number;
	encodeWaitMs: number;
};

// The encoder captures the canvas synchronously, so frame N+1 can decode
// while N encodes.
async function encodeFrames(
	context: RenderContext,
	job: BrowserExportJob,
	encoder: ExportEncoder,
	write: (
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	) => Promise<void>,
): Promise<LoopTimings> {
	const { totalFrames } = context;
	const timings = { renderMs: 0, decodeWaitMs: 0, encodeWaitMs: 0 };
	let pendingDecode: Promise<DecodedFrame | null> = decodeFrame(
		context,
		job.fps,
		0,
	);
	let lastProgress = 0;
	let lastGroup = -1;
	const writeReady = async () => {
		for (const { packet, meta } of encoder.take()) await write(packet, meta);
	};
	try {
		for (let frame = 0; frame < totalFrames; frame++) {
			checkCanceled();
			const decodeStart = performance.now();
			const item = await pendingDecode;
			timings.decodeWaitMs += performance.now() - decodeStart;
			if (!item) break;
			const renderStart = performance.now();
			await renderFrame(context, job, frame, item);
			timings.renderMs += performance.now() - renderStart;
			pendingDecode =
				frame + 1 < totalFrames
					? decodeFrame(context, job.fps, frame + 1)
					: Promise.resolve(null);
			const group = keyframeGroup(frame, job.fps, KEYFRAME_SECONDS);
			const encodeStart = performance.now();
			await encoder.encode(frame, group !== lastGroup, context.canvas);
			timings.encodeWaitMs += performance.now() - encodeStart;
			lastGroup = group;
			await writeReady();
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
		await encoder.flush();
		await writeReady();
	} catch (cause) {
		void pendingDecode.then(release, () => undefined);
		throw cause;
	}
	return timings;
}

async function runExport(job: BrowserExportJob) {
	const started = performance.now();
	const context = await renderContext(job);
	checkCanceled();
	const { width, height, totalFrames, times } = context;
	const {
		BufferTarget,
		EncodedPacket,
		EncodedVideoPacketSource,
		Mp4OutputFormat,
		Output,
		canEncodeVideo,
	} = await import("mediabunny");
	const bitrate = Math.round(
		exportBitrate(width, height, job.fps, job.bitsPerPixel) * BITRATE_SCALE,
	);
	if (!(await canEncodeVideo("avc", { width, height, bitrate }))) {
		throw new Error("This browser cannot encode H.264 video");
	}
	const encoderConfig = await supportedEncoderConfig({
		codec: avcCodecString(width, height, bitrate),
		width,
		height,
		bitrate,
		framerate: job.fps,
		latencyMode: HOLDS_QUALITY_FRAMES ? "realtime" : "quality",
		alpha: "discard",
		avc: { format: "avc" },
	});
	if (!encoderConfig) {
		throw new Error("This browser cannot encode H.264 video at this size");
	}
	const file = await openExportFile(
		((bitrate + EXPORT_AUDIO_BITRATE) * totalFrames) / job.fps / 8,
		job.outputFile,
	);
	const target = file?.target ?? new BufferTarget();
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: file ? "reserve" : "in-memory" }),
		target,
	});
	const encoder = new ExportEncoder(
		encoderConfig,
		job.fps,
		(chunk, frame, key) =>
			EncodedPacket.fromEncodedChunk(chunk).clone({
				timestamp: frame / job.fps,
				duration: 1 / job.fps,
				type: key ? "key" : "delta",
			}),
	);
	try {
		const videoSource = new EncodedVideoPacketSource("avc");
		output.addVideoTrack(videoSource, {
			frameRate: job.fps,
			maximumPacketCount: totalFrames + 16,
		});
		const audio = await renderBrowserExportAudio(
			job,
			times,
			output,
			totalFrames,
			(original, rejected) => sourceUrls.renew(original, rejected),
		);
		await output.start();
		const audioDone = audio?.run() ?? Promise.resolve();
		audioDone.catch(() => undefined);
		const timings = await encodeFrames(
			context,
			job,
			encoder,
			async (packet, meta) => {
				await videoSource.add(packet, meta);
			},
		);
		checkCanceled();
		encoder.close();
		videoSource.close();
		await audioDone;
		await output.finalize();
		const data = file
			? await file.finish()
			: target instanceof BufferTarget && target.buffer
				? new Blob([target.buffer], { type: "video/mp4" })
				: null;
		if (!data) throw new Error("Export produced no file");
		scope.postMessage({
			kind: "done",
			data,
			storedFile: file?.name ?? null,
			mimeType: "video/mp4",
			stats: {
				frames: totalFrames,
				width,
				height,
				renderMs: Math.round(timings.renderMs),
				decodeWaitMs: Math.round(timings.decodeWaitMs),
				encodeWaitMs: Math.round(timings.encodeWaitMs),
				captureMs: Math.round(encoder.captureMs),
				totalMs: Math.round(performance.now() - started),
				videoCodec: "avc",
				encoderAcceleration: encoderConfig.hardwareAcceleration ?? "",
				audioCodec: audio?.codec ?? null,
				backend: context.renderer.backend,
				webGpuFailover: context.failedOver,
			},
		});
	} catch (cause) {
		encoder.close();
		await output.cancel().catch(() => undefined);
		file?.discard();
		throw cause;
	}
}

let queue: Promise<void> = Promise.resolve();
let latestPreview = 0;

function enqueue(run: () => Promise<void>) {
	queue = queue.then(run, run).catch(() => undefined);
}

// The renderer module is the slowest part of a first export, so it starts
// loading as soon as the worker does.
void rendererModule().catch(() => undefined);

scope.addEventListener("message", (event) => {
	const message = event.data;
	if (isSourceUrlRenewReply(message)) {
		answerSourceUrl(message);
		return;
	}
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
