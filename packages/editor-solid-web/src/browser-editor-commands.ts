import {
	applyDefaultStyle,
	FULL_BLEED_STYLE,
} from "@cap/editor-cap-bundle/default-style";
import type {
	Audio,
	ProjectRecordingsMeta,
	SegmentRecordings,
	SerializedEditorInstance,
	Video,
} from "../../../apps/desktop/src/utils/tauri";
import type { BrowserEditorMediaMetadata } from "../../../apps/web/lib/browser-editor-metadata";
import {
	browserEditorPreviewConfig,
	browserEditorPreviewTime,
	onBrowserPreviewSettled,
} from "./browser-frame-socket";
import { acquireMediaInputAt } from "./browser-media-inputs";
import { probeBrowserMedia } from "./browser-media-probe";
import { loadBrowserRenderer } from "./browser-renderer";
import {
	BrowserEditorSourceCatalog,
	type BrowserEditorSources,
	type BrowserSourceSegment,
} from "./browser-sources";
import { BrowserVideoPool } from "./browser-video-pool";

type SegmentMedia = {
	display: BrowserEditorMediaMetadata;
	camera: BrowserEditorMediaMetadata | null;
	mic: BrowserEditorMediaMetadata | null;
	systemAudio: BrowserEditorMediaMetadata | null;
};

type BrowserEditorInfo = {
	sources: BrowserEditorSources;
	config: Record<string, unknown>;
	meta: Record<string, unknown>;
	instance: SerializedEditorInstance;
};

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function video(
	media: BrowserEditorMediaMetadata,
	fps: number | null,
	startTime: number,
): Video {
	if (media.width === null || media.height === null) {
		throw new Error("Editor video dimensions are unavailable");
	}
	return {
		duration: media.duration,
		width: media.width,
		height: media.height,
		fps: fps ?? 30,
		start_time: startTime,
	};
}

function audio(
	media: BrowserEditorMediaMetadata | null,
	startTime: number,
): Audio | null {
	if (!media || media.audioChannels === null || media.sampleRate === null) {
		return null;
	}
	return {
		duration: media.duration,
		sample_rate: media.sampleRate,
		channels: media.audioChannels,
		start_time: startTime,
	};
}

function path(index: number, kind: "display" | "camera" | "mic" | "system") {
	return `content/segments/segment-${index}/${kind}.webm`;
}

function waveform(url: string, signal: AbortSignal) {
	return new Promise<number[]>((resolve, reject) => {
		const worker = new Worker(
			new URL("./browser-waveform-worker.ts", import.meta.url),
			{ type: "module" },
		);
		const finish = () => {
			signal.removeEventListener("abort", cancel);
			worker.terminate();
		};
		const cancel = () => {
			finish();
			reject(new Error("Editor waveform was canceled"));
		};
		signal.addEventListener("abort", cancel, { once: true });
		worker.addEventListener(
			"message",
			(event: MessageEvent<{ peaks: number[] } | { error: string }>) => {
				finish();
				if ("peaks" in event.data) resolve(event.data.peaks);
				else reject(new Error(event.data.error));
			},
		);
		worker.addEventListener("error", () => {
			finish();
			reject(new Error("Editor waveform could not load"));
		});
		worker.postMessage({ url });
	});
}

const WAVEFORM_CACHE = "cap-editor-waveforms-v1";
const WAVEFORM_CACHE_ENTRIES = 40;

/// A waveform costs a read of the whole audio file and seconds of decoding
/// (about 15 CPU seconds for two hours). Signed URLs change on every visit, so
/// the peaks are keyed by object path and exact duration.
async function cachedWaveform(url: string, signal: AbortSignal) {
	let cache: Cache | null = null;
	let key: string | null = null;
	try {
		const { duration } = await probeBrowserMedia(url, signal);
		const { origin, pathname } = new URL(url);
		key = `${origin}/__cap-waveform${pathname}?duration=${duration}`;
		cache = await caches.open(WAVEFORM_CACHE);
		const hit = await cache.match(key);
		if (hit) return Array.from(new Float32Array(await hit.arrayBuffer()));
	} catch {
		if (signal.aborted) throw signal.reason;
	}
	// Streaming the whole audio file would compete with the first preview
	// frame's reads, so it starts once the preview has painted.
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		let unsubscribe: (() => void) | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe?.();
			signal.removeEventListener("abort", abort);
			if (error === undefined) resolve();
			else reject(error);
		};
		const abort = () =>
			finish(signal.reason ?? new DOMException("Canceled", "AbortError"));
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		timer = setTimeout(() => finish(), 10_000);
		unsubscribe = onBrowserPreviewSettled(() => finish());
		if (settled) unsubscribe();
	});
	const peaks = await waveform(url, signal);
	if (cache && key && peaks.length > 0) {
		const store = cache;
		void store
			.put(key, new Response(new Float32Array(peaks)))
			.then(() => store.keys())
			.then((keys) =>
				Promise.all(
					keys
						.slice(0, Math.max(0, keys.length - WAVEFORM_CACHE_ENTRIES))
						.map((old) => store.delete(old)),
				),
			)
			.catch(() => undefined);
	}
	return peaks;
}

const THUMBNAIL_WIDTH = 320;
const ZOOM_PREVIEW_WIDTH = 1280;
const THUMBNAIL_CACHE_ENTRIES = 64;

/// A <video> element reads the whole of a fragmented recording before it can
/// show a frame (over a gigabyte for two hours of screen), so thumbnails
/// decode from the preview's mediabunny Input. Null when WebCodecs cannot
/// decode the file.
async function decodeFrameAt(url: string, time: number) {
	if (typeof VideoDecoder !== "function") return null;
	const { VideoSampleSink } = await import("mediabunny");
	const { input, release } = await acquireMediaInputAt(url, time);
	try {
		const track = await input.getPrimaryVideoTrack();
		const config = await track?.getDecoderConfig();
		if (
			!track ||
			!config ||
			!(await VideoDecoder.isConfigSupported(config)).supported
		) {
			return null;
		}
		const first = (await track.getFirstTimestamp()) ?? 0;
		const sample = await new VideoSampleSink(track).getSample(
			Math.max(time, first),
		);
		if (!sample) return null;
		try {
			return sample.toVideoFrame();
		} finally {
			sample.close();
		}
	} finally {
		release();
	}
}

export class BrowserEditorCommands {
	static supports(name: string) {
		return [
			"animatedGradientCatalog",
			"randomAnimatedGradient",
			"getMicWaveforms",
			"getSystemAudioWaveforms",
			"getEditorProjectPath",
			"getRecordingMetaByPath",
			"getEditorMeta",
			"createEditorInstance",
			"getVideoMetadata",
			"getDefaultProjectConfig",
			"getDisplayFrameForCropping",
			"getClipThumbnail",
			"tauri:webEditorCameraThumbnail",
			"tauri:webEditorZoomPreviewFrame",
			"loadCaptions",
			"setWindowTransparent",
			"tauri:get_recording_recovery_success",
		].includes(name);
	}

	private readonly controller = new AbortController();
	private readonly catalog: BrowserEditorSourceCatalog;
	private pending: Promise<BrowserEditorInfo> | null = null;
	private info: BrowserEditorInfo | null = null;
	private readonly thumbnails = new Map<string, Promise<string>>();

	constructor(
		private readonly videoId: string,
		private readonly sessionId: string,
	) {
		this.catalog = new BrowserEditorSourceCatalog(videoId);
	}

	private async media(sources: BrowserEditorSources): Promise<SegmentMedia[]> {
		const segments = sources.segments;
		const results = new Array<SegmentMedia>(segments.length);
		let next = 0;
		await Promise.all(
			Array.from({ length: Math.min(4, segments.length) }, async () => {
				while (next < segments.length) {
					const index = next++;
					const segment = segments[index];
					if (!segment?.display) {
						throw new Error("Editor imported recording media is unavailable");
					}
					const [display, camera, mic, systemAudio] = await Promise.all([
						probeBrowserMedia(segment.display.url, this.controller.signal),
						segment.camera
							? probeBrowserMedia(segment.camera.url, this.controller.signal)
							: Promise.resolve(null),
						index === 0 && sources.mic
							? probeBrowserMedia(
									sources.mic.url,
									this.controller.signal,
								).catch(() => null)
							: Promise.resolve(null),
						index === 0 && sources.systemAudio
							? probeBrowserMedia(
									sources.systemAudio.url,
									this.controller.signal,
								).catch(() => null)
							: Promise.resolve(null),
					]);
					results[index] = { display, camera, mic, systemAudio };
				}
			}),
		);
		return results;
	}

	private recording(
		segment: BrowserSourceSegment,
		media: SegmentMedia,
	): SegmentRecordings {
		return {
			display: video(media.display, segment.displayFps, 0),
			camera: media.camera
				? video(
						media.camera,
						segment.cameraFps,
						(segment.cameraOffsetMs ?? 0) / 1000,
					)
				: null,
			mic: audio(media.mic, (segment.micOffsetMs ?? 0) / 1000),
			system_audio: audio(
				media.systemAudio,
				(segment.systemAudioOffsetMs ?? 0) / 1000,
			),
		};
	}

	private async load(): Promise<BrowserEditorInfo> {
		const sources = await this.catalog.snapshot(this.controller.signal);
		const [media, config] = await Promise.all([
			this.media(sources),
			sources.projectConfig ??
				loadBrowserRenderer().then((module): unknown => {
					const defaults: unknown = JSON.parse(
						module.default_project_config_json(),
					);
					const project = record(defaults);
					return project && sources.defaultStyle
						? applyDefaultStyle(project, sources.defaultStyle)
						: defaults;
				}),
		]);
		const project = record(config);
		if (!project) throw new Error("Editor project configuration is invalid");
		const recordings: ProjectRecordingsMeta = {
			segments: sources.segments.map((segment, index) => {
				const item = media[index];
				if (!item) throw new Error("Editor recording metadata is unavailable");
				return this.recording(segment, item);
			}),
		};
		const recordingDuration = recordings.segments.reduce(
			(total, segment) =>
				total +
				Math.max(
					segment.display.duration,
					segment.camera?.duration ?? 0,
					segment.mic?.duration ?? 0,
				),
			0,
		);
		const editorPath = `cap-web-editor://session/${this.sessionId}`;
		const meta = {
			platform: "MacOS",
			pretty_name: sources.title,
			sharing: {
				id: this.videoId,
				link: new URL(
					`/s/${encodeURIComponent(this.videoId)}`,
					window.location.origin,
				).toString(),
			},
			segments: sources.segments.map((segment, index) => ({
				display: {
					path: path(index, "display"),
					fps: segment.displayFps ?? 30,
					start_time: 0,
				},
				...(segment.camera
					? {
							camera: {
								path: path(index, "camera"),
								fps: segment.cameraFps ?? segment.displayFps ?? 30,
								start_time: (segment.cameraOffsetMs ?? 0) / 1000,
							},
						}
					: {}),
				...(index === 0 && recordings.segments[index]?.mic
					? {
							mic: {
								path: path(index, "mic"),
								start_time: (segment.micOffsetMs ?? 0) / 1000,
							},
						}
					: {}),
				...(index === 0 && recordings.segments[index]?.system_audio
					? {
							system_audio: {
								path: path(index, "system"),
								start_time: (segment.systemAudioOffsetMs ?? 0) / 1000,
							},
						}
					: {}),
				...(index === 0 && sources.inputEvents
					? { cursor: `content/segments/segment-${index}/input-events.ndjson` }
					: {}),
			})),
			cursors: {},
			status: { status: "Complete" },
			audioOnly: sources.audioOnly,
		};
		const instance = {
			instanceId: crypto.randomUUID(),
			preparingPlayback: false,
			preparingSnapshot: null,
			framesSocketUrl: editorPath,
			recordingDuration,
			savedProjectConfig: project,
			recordings,
			path: editorPath,
			notchBase: {
				x: 0.4384920634920635,
				width: 0.12235449735449735,
				height: 0.032586558044806514,
			},
		} as SerializedEditorInstance;
		return { sources, config: project, meta, instance };
	}

	private async snapshot() {
		if (this.controller.signal.aborted) {
			throw new Error("Editor browser session is closed");
		}
		if (this.info) return this.info;
		if (!this.pending) {
			this.pending = this.load().then(
				(info) => {
					this.info = info;
					return info;
				},
				(error: unknown) => {
					this.pending = null;
					throw error;
				},
			);
		}
		return this.pending;
	}

	private async displayFrameForCropping(fps: number) {
		if (!Number.isSafeInteger(fps) || fps < 1 || fps > 120) {
			throw new Error("Editor crop frame rate is invalid");
		}
		const [info, sources, module] = await Promise.all([
			this.snapshot(),
			this.catalog.snapshot(this.controller.signal),
			loadBrowserRenderer(),
		]);
		const config = record(browserEditorPreviewConfig()) ?? info.config;
		const sourceDurations = info.instance.recordings.segments.map((segment) =>
			Math.max(
				segment.display.duration,
				segment.camera?.duration ?? 0,
				segment.mic?.duration ?? 0,
			),
		);
		const timelineConfig = record(config.timeline) ?? {
			segments: sourceDurations.map((duration, recordingSegment) => ({
				recordingSegment,
				timescale: 1,
				start: 0,
				end: duration,
			})),
			transitions: [],
			zoomSegments: [],
		};
		const timeline = new module.BrowserTimeline(JSON.stringify(timelineConfig));
		const timings = new module.BrowserRecordingTimes(
			JSON.stringify(info.meta),
			JSON.stringify(config.clips ?? []),
		);
		let segmentIndex: number;
		let sourceTime: number;
		try {
			const outputTime = Math.max(
				0,
				Math.floor(browserEditorPreviewTime() * fps) / fps,
			);
			const mapped = timeline.map_frame(outputTime);
			segmentIndex = mapped[2] ?? -1;
			const sourceTimes = timings.source_times(segmentIndex, mapped[3] ?? -1);
			sourceTime = sourceTimes[0] ?? -1;
		} finally {
			timings.free();
			timeline.free();
		}
		if (
			!Number.isSafeInteger(segmentIndex) ||
			segmentIndex < 0 ||
			!Number.isFinite(sourceTime) ||
			sourceTime < 0
		) {
			throw new Error("Editor crop source time is unavailable");
		}
		const image = await this.displayFrame(sources, segmentIndex, sourceTime);
		return new Uint8Array(await image.arrayBuffer());
	}

	private async clipThumbnail(
		recordingSegment: number,
		sourceTime: number,
		track: "display" | "camera" = "display",
		width = THUMBNAIL_WIDTH,
	) {
		if (
			!Number.isSafeInteger(recordingSegment) ||
			recordingSegment < 0 ||
			!Number.isFinite(sourceTime) ||
			sourceTime < 0
		) {
			throw new Error("Clip thumbnail request is invalid");
		}
		// The clip strip asks again whenever the timeline re-renders.
		const key = `${track}:${width}:${recordingSegment}:${sourceTime}`;
		const cached = this.thumbnails.get(key);
		if (cached) return cached;
		const thumbnail = this.catalog
			.snapshot(this.controller.signal)
			.then((sources) =>
				this.displayFrame(sources, recordingSegment, sourceTime, width, track),
			)
			.then(
				(image) =>
					new Promise<string>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () => resolve(String(reader.result));
						reader.onerror = () =>
							reject(new Error("Clip thumbnail could not load"));
						reader.readAsDataURL(image);
					}),
			);
		this.thumbnails.set(key, thumbnail);
		thumbnail.catch(() => {
			if (this.thumbnails.get(key) === thumbnail) this.thumbnails.delete(key);
		});
		for (const old of this.thumbnails.keys()) {
			if (this.thumbnails.size <= THUMBNAIL_CACHE_ENTRIES) break;
			this.thumbnails.delete(old);
		}
		return thumbnail;
	}

	private async displayFrame(
		sources: BrowserEditorSources,
		segmentIndex: number,
		sourceTime: number,
		maxWidth?: number,
		track: "display" | "camera" = "display",
	) {
		const source = sources.segments[segmentIndex]?.[track];
		if (!source) throw new Error(`Editor ${track} source is unavailable`);
		const decoded = await decodeFrameAt(source.url, sourceTime).catch(
			() => null,
		);
		const pool = decoded
			? null
			: new BrowserVideoPool(async (index, requested) =>
					index === segmentIndex && requested === track ? source : null,
				);
		try {
			const image =
				decoded ??
				(await pool?.frame(
					segmentIndex,
					track,
					"primary",
					sourceTime,
					false,
					1,
					this.controller.signal,
				));
			const width =
				image instanceof VideoFrame ? image.displayWidth : image?.videoWidth;
			const height =
				image instanceof VideoFrame ? image.displayHeight : image?.videoHeight;
			if (!image || !width || !height) {
				throw new Error("Editor display frame is unavailable");
			}
			const scale = maxWidth ? Math.min(1, maxWidth / width) : 1;
			const canvas = document.createElement("canvas");
			canvas.width = Math.round(width * scale);
			canvas.height = Math.round(height * scale);
			const context = canvas.getContext("2d");
			if (!context) throw new Error("Editor frame canvas is unavailable");
			context.drawImage(image, 0, 0, canvas.width, canvas.height);
			const blob = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob(resolve, "image/jpeg", 0.86),
			);
			if (!blob) throw new Error("Editor frame image could not encode");
			return blob;
		} finally {
			decoded?.close();
			pool?.dispose();
		}
	}

	async invoke(name: string, args: unknown[]): Promise<unknown> {
		if (name === "getDisplayFrameForCropping") {
			return this.displayFrameForCropping(Number(args[0]));
		}
		if (name === "getClipThumbnail") {
			return this.clipThumbnail(Number(args[0]), Number(args[1]));
		}
		if (name === "tauri:webEditorCameraThumbnail") {
			return this.clipThumbnail(0, 1, "camera");
		}
		if (name === "tauri:webEditorZoomPreviewFrame") {
			const request = record(args[0]);
			return this.clipThumbnail(
				Number(request?.recordingSegment),
				Number(request?.sourceTime),
				"display",
				ZOOM_PREVIEW_WIDTH,
			);
		}
		if (name === "animatedGradientCatalog") {
			return JSON.parse(
				(await loadBrowserRenderer()).animated_gradient_catalog_json(),
			);
		}
		if (name === "randomAnimatedGradient") {
			const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
			return JSON.parse(
				(await loadBrowserRenderer()).random_animated_gradient_json(seed),
			);
		}
		if (name === "getMicWaveforms" || name === "getSystemAudioWaveforms") {
			const sources = await this.catalog.snapshot(this.controller.signal);
			const tracks: number[][] = sources.segments.map(() => []);
			const source =
				name === "getMicWaveforms"
					? sources.mic
					: (sources.systemAudio ??
						(sources.displayHasAudio ? sources.segments[0]?.display : null));
			if (source) {
				tracks[0] = await cachedWaveform(
					source.url,
					this.controller.signal,
				).catch(() => []);
			}
			return tracks;
		}
		if (name === "getDefaultProjectConfig") {
			const [module, sources] = await Promise.all([
				loadBrowserRenderer(),
				this.catalog.snapshot(this.controller.signal),
			]);
			const defaults: unknown = JSON.parse(
				module.default_project_config_json(),
			);
			const project = record(defaults);
			// Cap's look for a recording: edge to edge, with its camera where it
			// was recorded.
			return project
				? applyDefaultStyle(project, {
						...FULL_BLEED_STYLE,
						camera: sources.defaultStyle?.camera,
					})
				: defaults;
		}
		if (name === "setWindowTransparent") return null;
		if (name === "tauri:get_recording_recovery_success") return false;
		const info = await this.snapshot();
		switch (name) {
			case "getEditorProjectPath":
				return info.instance.path;
			case "getRecordingMetaByPath":
				if (args[0] !== info.instance.path) {
					throw new Error("Editor project path is invalid");
				}
				return info.meta;
			case "getEditorMeta":
				return info.meta;
			case "createEditorInstance":
				return info.instance;
			case "getVideoMetadata": {
				if (args[0] !== info.instance.path) {
					throw new Error("Editor project path is invalid");
				}
				const duration = info.instance.recordings.segments.reduce(
					(total, segment) => total + segment.display.duration,
					0,
				);
				return {
					duration,
					size: duration * (8_192_000 / (8 * 1024 * 1024)),
				};
			}
			case "loadCaptions":
				return info.sources.captionsEnabled
					? (info.config.captions ?? null)
					: null;
			default:
				throw new Error(`Unsupported browser editor command: ${name}`);
		}
	}

	dispose() {
		this.controller.abort();
		this.catalog.dispose();
		this.info = null;
		this.pending = null;
	}
}
