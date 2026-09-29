// Local MP4 export. Runs the same native render core as the preview on WebGPU
// in a worker: sources decode in presentation order with WebCodecs, frames
// render into an OffscreenCanvas and go straight to the hardware H.264
// encoder, so no pixels round-trip through the CPU.
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
} from "./browser-export-encoder";
import { EXPORT_AUDIO_BITRATE, exportBitrate } from "./browser-export-estimate";
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
	/** Posts playable chunks while it renders, for watching before it's done. */
	chunked?: boolean;
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
	| { kind: "chunk-init"; data: Uint8Array }
	| { kind: "chunk"; data: Uint8Array; duration: number }
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
	backend: string;
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

const EXPORT_FILE_PREFIX = "cap-export-";

type ExportDirectory = FileSystemDirectoryHandle & {
	keys(): AsyncIterable<string>;
};

type SyncAccessHandle = {
	write(data: BufferSource, options: { at: number }): number;
	flush(): void;
	close(): void;
};

/// Streams the MP4 into the origin private file system, so a long export
/// never has to fit in memory. Earlier exports are removed except the newest,
/// which a download or upload may still be reading. Returns null when there
/// is no room, and the export is built in memory instead.
async function openExportFile(maxBytes: number) {
	try {
		const root = (await navigator.storage.getDirectory()) as ExportDirectory;
		const stale: string[] = [];
		for await (const name of root.keys())
			if (name.startsWith(EXPORT_FILE_PREFIX)) stale.push(name);
		stale.sort();
		stale.pop();
		await Promise.all(
			stale.map((name) => root.removeEntry(name).catch(() => undefined)),
		);
		const { quota = 0, usage = 0 } = await navigator.storage.estimate();
		if (quota - usage < maxBytes * 1.2) return null;
		const name = `${EXPORT_FILE_PREFIX}${Date.now()}.mp4`;
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

const CHUNK_SECONDS = 2;

// Safari's H.264 encoder holds frames in quality mode until more arrive,
// while the export sends the next frame only once the last is encoded.
const HOLDS_QUALITY_FRAMES =
	/AppleWebKit/.test(navigator.userAgent) &&
	!/Chrome|Chromium|Edg/.test(navigator.userAgent);

const joinBytes = (parts: Uint8Array[]) => {
	const joined = new Uint8Array(
		parts.reduce((size, part) => size + part.length, 0),
	);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
};

/// Splits a fragmented MP4 as it's written into its init segment and one
/// media segment per fragment, each posted once its duration is known.
function chunkPoster() {
	const header: Uint8Array[] = [];
	let pending: { parts: Uint8Array[]; start: number } | null = null;
	const post = (end: number) => {
		if (!pending) return;
		const data = joinBytes(pending.parts);
		scope.postMessage({ kind: "chunk", data, duration: end - pending.start }, [
			data.buffer,
		]);
		pending = null;
	};
	const callbacks = {
		onFtyp: (data: Uint8Array) => {
			header.push(data.slice());
		},
		onMoov: (data: Uint8Array) => {
			header.push(data.slice());
			const init = joinBytes(header);
			scope.postMessage({ kind: "chunk-init", data: init }, [init.buffer]);
		},
		onMoof: (data: Uint8Array, _position: number, timestamp: number) => {
			post(timestamp);
			pending = { parts: [data.slice()], start: timestamp };
		},
		onMdat: (data: Uint8Array) => {
			pending?.parts.push(data.slice());
		},
	};
	return { callbacks, finish: post };
}

/// The export as fragments for watching while it renders, built from the
/// packets the export's encoders produce, so nothing is encoded or stored
/// twice. Streaming stops, and the export carries on, if muxing fails.
async function chunkStream(fps: number) {
	const {
		EncodedAudioPacketSource,
		EncodedVideoPacketSource,
		Mp4OutputFormat,
		NullTarget,
		Output,
	} = await import("mediabunny");
	const poster = chunkPoster();
	const output = new Output({
		format: new Mp4OutputFormat({
			fastStart: "fragmented",
			minimumFragmentDuration: CHUNK_SECONDS,
			...poster.callbacks,
		}),
		target: new NullTarget(),
	});
	const video = new EncodedVideoPacketSource("avc");
	output.addVideoTrack(video, { frameRate: fps });
	let audio: InstanceType<typeof EncodedAudioPacketSource> | null = null;
	let queue: Promise<void> = Promise.resolve();
	let failed = false;
	const add = (task: () => Promise<void> | undefined) => {
		queue = queue
			.then(() => (failed ? undefined : task()))
			.catch(() => {
				failed = true;
			});
	};
	return {
		video: (packet: EncodedPacket, meta?: EncodedVideoChunkMetadata) =>
			add(() => video.add(packet, meta)),
		audio: (packet: EncodedPacket, meta?: EncodedAudioChunkMetadata) =>
			add(() => audio?.add(packet, meta)),
		async start(audioCodec: "aac" | "opus" | null) {
			if (audioCodec) {
				audio = new EncodedAudioPacketSource(audioCodec);
				output.addAudioTrack(audio);
			}
			await output.start();
		},
		async finish(duration: number) {
			await queue;
			if (failed) return;
			video.close();
			audio?.close();
			await output.finalize().then(
				() => poster.finish(duration),
				() => undefined,
			);
		},
		cancel: () => output.cancel().catch(() => undefined),
	};
}

type LoopTimings = {
	renderMs: number;
	decodeWaitMs: number;
	encodeWaitMs: number;
};

/// Frame N renders and is handed to the encoder (which captures the canvas
/// synchronously), then frame N+1 decodes while N encodes; finished packets
/// are written between frames.
async function encodeFrames(
	context: RenderContext,
	job: BrowserExportJob,
	encoder: ExportEncoder,
	write: (
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	) => Promise<void>,
): Promise<LoopTimings> {
	const { canvas, totalFrames } = context;
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
			renderDecoded(context, job, frame, item);
			timings.renderMs += performance.now() - renderStart;
			pendingDecode =
				frame + 1 < totalFrames
					? decodeFrame(context, job.fps, frame + 1)
					: Promise.resolve(null);
			const group = keyframeGroup(frame, job.fps, CHUNK_SECONDS);
			const encodeStart = performance.now();
			await encoder.encode(frame, group !== lastGroup, canvas);
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
	const bitrate = exportBitrate(width, height, job.fps, job.bitsPerPixel);
	if (!(await canEncodeVideo("avc", { width, height, bitrate }))) {
		throw new Error("This browser cannot encode H.264 video");
	}
	const encoderConfig: VideoEncoderConfig = {
		codec: avcCodecString(width, height, bitrate),
		width,
		height,
		bitrate,
		framerate: job.fps,
		latencyMode: HOLDS_QUALITY_FRAMES ? "realtime" : "quality",
		hardwareAcceleration: "prefer-hardware",
		alpha: "discard",
		avc: { format: "avc" },
	};
	const support = await VideoEncoder.isConfigSupported(encoderConfig);
	if (!support.supported) {
		throw new Error("This browser cannot encode H.264 video at this size");
	}
	const file = await openExportFile(
		((bitrate + EXPORT_AUDIO_BITRATE) * totalFrames) / job.fps / 8,
	);
	const target = file?.target ?? new BufferTarget();
	const stream = job.chunked ? await chunkStream(job.fps) : null;
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
			stream?.audio,
		);
		await stream?.start(audio?.codec ?? null);
		await output.start();
		const audioDone = audio?.run() ?? Promise.resolve();
		audioDone.catch(() => undefined);
		const timings = await encodeFrames(
			context,
			job,
			encoder,
			async (packet, meta) => {
				stream?.video(packet, meta);
				await videoSource.add(packet, meta);
			},
		);
		checkCanceled();
		encoder.close();
		videoSource.close();
		await audioDone;
		await output.finalize();
		await stream?.finish(totalFrames / job.fps);
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
				totalMs: Math.round(performance.now() - started),
				videoCodec: "avc",
				audioCodec: audio?.codec ?? null,
				backend: context.renderer.backend,
			},
		});
	} catch (cause) {
		encoder.close();
		await output.cancel().catch(() => undefined);
		await stream?.cancel();
		file?.discard();
		throw cause;
	}
}

// Jobs share one render context, so they run one at a time; a preview that
// a newer preview superseded while queued is skipped.
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
