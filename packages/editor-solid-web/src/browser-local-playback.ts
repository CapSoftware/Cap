import type {
	BrowserRecordingTimes,
	BrowserTimeline,
	BrowserVisualConfig,
} from "../renderer/pkg/cap_editor_browser_renderer.js";
import { BrowserAudioPlayback } from "./browser-audio-playback";
import { BrowserDecodedVideoPool } from "./browser-decoded-video-pool";
import {
	type BrowserClipFrame,
	BrowserLocalCanvas,
	type BrowserRenderedFrame,
	type BrowserStudioSetup,
} from "./browser-local-canvas";
import { probeBrowserMedia } from "./browser-media-probe";
import { loadBrowserRenderer } from "./browser-renderer";
import {
	BrowserEditorSourceCatalog,
	type BrowserEditorSources,
} from "./browser-sources";
import {
	recordingMeta,
	studioRecordingMeta,
	webInputRecording,
} from "./browser-studio-setup";
import { BrowserVideoPool, type BrowserVideoRole } from "./browser-video-pool";

type RendererModule = Awaited<ReturnType<typeof loadBrowserRenderer>>;

type TimelineSegment = {
	recordingSegment: number;
	timescale: number;
	speedAudioMode: "maintainPitch" | "matchSpeed" | "mute" | null;
	volume: number;
};

type TrackFrame = {
	source: HTMLVideoElement | ImageBitmap;
	width: number;
	height: number;
	mediaTime: number;
	release: () => void;
	sourceColorFix: boolean;
};

function releasePair(pair: BrowserClipFrame | null) {
	if (!pair) return;
	pair.screen.release();
	pair.camera?.release();
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function numeric(value: unknown, fallback: number) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function visiblePreviewSize(
	canvas: HTMLCanvasElement,
	width: number,
	height: number,
	renderScale = 1,
) {
	const bounds = canvas.getBoundingClientRect();
	const density = window.devicePixelRatio;
	if (
		bounds.width < 2 ||
		bounds.height < 2 ||
		!Number.isFinite(density) ||
		density <= 0
	) {
		return [width, height] as const;
	}
	const scale =
		Math.min(
			1,
			(bounds.width * density) / width,
			(bounds.height * density) / height,
		) * renderScale;
	return [
		Math.max(2, Math.round((width * scale) / 2) * 2),
		Math.max(2, Math.round((height * scale) / 2) * 2),
	] as const;
}

/// The desktop preview quality presets size frames for a fixed 1080p output.
/// In the browser the renderer is cheap, so Full and Half render at the
/// canvas's real device-pixel size (never softer than the preset, capped at
/// 4K); Quarter stays a deliberate low-detail mode.
function previewDetailBase(
	canvas: HTMLCanvasElement,
	width: number,
	height: number,
) {
	if (width < 960) return { width, height };
	const bounds = canvas.getBoundingClientRect();
	const density = window.devicePixelRatio;
	if (bounds.width < 2 || bounds.height < 2 || !(density > 0)) {
		return { width, height };
	}
	const scale = Math.min(
		Math.max(
			1,
			(bounds.width * density) / width,
			(bounds.height * density) / height,
		),
		3840 / width,
		2160 / height,
	);
	return {
		width: Math.max(width, Math.round(width * scale)),
		height: Math.max(height, Math.round(height * scale)),
	};
}

function timelineConfig(config: unknown, sourceDurations: number[]) {
	const saved = record(record(config)?.timeline);
	if (saved) return saved;
	return {
		segments: sourceDurations.map((duration, recordingSegment) => ({
			recordingSegment,
			timescale: 1,
			start: 0,
			end: duration,
		})),
		transitions: [],
		zoomSegments: [],
	};
}

function segmentSettings(config: Record<string, unknown>) {
	const segments = config.segments;
	if (!Array.isArray(segments)) {
		throw new Error("Editor timeline clips are invalid");
	}
	return segments.map((value): TimelineSegment => {
		const segment = record(value);
		const speedAudioMode = segment?.speedAudioMode ?? null;
		const recordingSegment = segment?.recordingSegment ?? 0;
		const volume = numeric(segment?.volume, 1);
		if (
			!segment ||
			!Number.isSafeInteger(recordingSegment) ||
			Number(recordingSegment) < 0 ||
			typeof segment.timescale !== "number" ||
			!Number.isFinite(segment.timescale) ||
			segment.timescale <= 0 ||
			(speedAudioMode !== null &&
				speedAudioMode !== "maintainPitch" &&
				speedAudioMode !== "matchSpeed" &&
				speedAudioMode !== "mute")
		) {
			throw new Error("Editor timeline clip speed is invalid");
		}
		return {
			recordingSegment: Number(recordingSegment),
			timescale: segment.timescale,
			speedAudioMode,
			volume: Math.max(0, Math.min(volume, 2)),
		};
	});
}

export class BrowserLocalPlayback {
	private readonly audio: BrowserAudioPlayback;
	private timeline: BrowserTimeline;
	private times: BrowserRecordingTimes;
	private visual: BrowserVisualConfig;
	private segments: TimelineSegment[];
	private frameController: AbortController | null = null;
	private frameSequence = 0;
	private animationFrame = 0;
	private frameBusy = false;
	private playing = false;
	private disposed = false;
	private outputTime = 0;
	private playStartedAt = 0;
	private playStartedTime = 0;
	private lastRequestedFrame = -1;
	private previewScale: 1 | 0.75 | 0.5 = 1;
	private averageFrameCostMs = 0;
	private lastRenderedAt = 0;
	private playClockAligned = false;
	private slowFrames = 0;
	private fastFrames = 0;

	private constructor(
		readonly sources: BrowserEditorSources,
		private readonly catalog: BrowserEditorSourceCatalog,
		private readonly pool: BrowserVideoPool,
		private readonly decodedPool: BrowserDecodedVideoPool,
		private readonly canvas: BrowserLocalCanvas,
		private readonly visibleCanvas: HTMLCanvasElement,
		private width: number,
		private height: number,
		private readonly module: RendererModule,
		config: unknown,
		readonly recordingDuration: number,
		private readonly sourceDurations: number[],
		private readonly onError: (error: Error) => void,
		unavailableMicUrl: string | null,
		private readonly screenWidth: number,
		private readonly screenHeight: number,
		private previewBase: { width: number; height: number } | null,
		private readonly colorHints: Map<string, Promise<boolean>>,
	) {
		const timeline = timelineConfig(config, sourceDurations);
		this.segments = segmentSettings(timeline);
		this.timeline = new module.BrowserTimeline(JSON.stringify(timeline));
		this.times = new module.BrowserRecordingTimes(
			JSON.stringify(recordingMeta(sources)),
			JSON.stringify(record(config)?.clips ?? []),
		);
		this.visual = new module.BrowserVisualConfig(JSON.stringify(config));
		this.audio = new BrowserAudioPlayback(catalog, onError);
		if (unavailableMicUrl) this.audio.markUnavailable(unavailableMicUrl);
		this.audio.setConfig(config);
	}

	static async create(
		videoId: string,
		canvas: HTMLCanvasElement,
		width: number,
		height: number,
		onFrame: (frame: BrowserRenderedFrame) => void,
		onError: (error: Error) => void,
		initialTime = 0,
	) {
		const catalog = new BrowserEditorSourceCatalog(videoId);
		const pool = new BrowserVideoPool(catalog.sourceProvider);
		const decodedPool = new BrowserDecodedVideoPool(catalog.sourceProvider);
		let controls: BrowserLocalCanvas | null = null;
		let playback: BrowserLocalPlayback | null = null;
		const controller = new AbortController();
		try {
			const signal = controller.signal;
			const [sources, module] = await Promise.all([
				catalog.snapshot(signal),
				loadBrowserRenderer(),
			]);
			const firstSegment = sources.segments[0];
			if (!firstSegment?.display) {
				throw new Error("Editor display recording is unavailable");
			}
			const firstDisplay = firstSegment.display;
			const metadataPromise = (async () => {
				const [display, camera, mic] = await Promise.all([
					probeBrowserMedia(firstDisplay.url, signal),
					firstSegment.camera
						? probeBrowserMedia(firstSegment.camera.url, signal)
						: Promise.resolve(null),
					sources.mic
						? probeBrowserMedia(sources.mic.url, signal).catch(() => null)
						: Promise.resolve(null),
				]);
				return { display, camera, mic };
			})();
			const [metadata, input] = await Promise.all([
				metadataPromise,
				webInputRecording(sources, module, signal),
			]);
			if (metadata.display.width === null || metadata.display.height === null) {
				throw new Error("Editor recording duration is unavailable");
			}
			const display = {
				videoWidth: metadata.display.width,
				videoHeight: metadata.display.height,
			};
			const firstDuration = Math.max(
				metadata.display.duration,
				metadata.camera?.duration ?? 0,
				metadata.mic?.duration ?? 0,
			);
			const sourceDurations = sources.segments.map((segment, index) => {
				if (index === 0) return firstDuration;
				if (segment.duration === null) {
					throw new Error("Editor imported recording media is unavailable");
				}
				return segment.duration;
			});
			const recordingDuration = sourceDurations.reduce(
				(total, duration) => total + duration,
				0,
			);
			const config =
				sources.projectConfig ??
				JSON.parse(module.default_project_config_json());
			const colorHints = new Map<string, Promise<boolean>>();
			colorHints.set(
				firstDisplay.url,
				Promise.resolve(metadata.display.untaggedSdH264),
			);
			if (firstSegment.camera && metadata.camera) {
				colorHints.set(
					firstSegment.camera.url,
					Promise.resolve(metadata.camera.untaggedSdH264),
				);
			}
			const previewBase =
				width === 0 && height === 0 ? { width: 1248, height: 702 } : null;
			if ((width === 0) !== (height === 0)) {
				throw new Error("Editor canvas dimensions are invalid");
			}
			if (previewBase) {
				const visual = new module.BrowserVisualConfig(JSON.stringify(config));
				try {
					const detail = previewDetailBase(
						canvas,
						previewBase.width,
						previewBase.height,
					);
					const size = visual.output_dimensions(
						display.videoWidth,
						display.videoHeight,
						detail.width,
						detail.height,
					);
					if (size.length !== 2 || size[0] < 2 || size[1] < 2) {
						throw new Error("Editor output dimensions are unavailable");
					}
					[width, height] = visiblePreviewSize(canvas, size[0], size[1]);
				} finally {
					visual.free();
				}
			}
			const setup: BrowserStudioSetup = {
				recordingMeta: studioRecordingMeta(sources, input),
				screenWidth: display.videoWidth,
				screenHeight: display.videoHeight,
				cameraWidth: metadata.camera?.width ?? 0,
				cameraHeight: metadata.camera?.height ?? 0,
				cursors: sources.segments.map((_, index) =>
					index === 0 && input ? JSON.stringify(input.cursor) : null,
				),
			};
			controls = new BrowserLocalCanvas(setup, width, height, onFrame, () => {
				const current = playback;
				if (current && !current.playing && !current.disposed) {
					void current.seek(current.outputTime).catch(() => undefined);
				}
			});
			controls.initDirectCanvas(canvas);
			playback = new BrowserLocalPlayback(
				sources,
				catalog,
				pool,
				decodedPool,
				controls,
				canvas,
				width,
				height,
				module,
				config,
				recordingDuration,
				sourceDurations,
				onError,
				metadata.mic ? null : (sources.mic?.url ?? null),
				display.videoWidth,
				display.videoHeight,
				previewBase,
				colorHints,
			);
			await controls.setProjectConfig(config);
			await playback.seek(
				Math.min(initialTime, Math.max(0, recordingDuration - 1 / 60)),
			);
			return playback;
		} catch (error) {
			controller.abort();
			if (playback) playback.dispose();
			else {
				controls?.dispose();
				pool.dispose();
				decodedPool.dispose();
				catalog.dispose();
			}
			throw error;
		}
	}

	async setConfig(config: unknown) {
		if (this.disposed) throw new Error("Editor playback is closed");
		const timeline = timelineConfig(config, this.sourceDurations);
		const segments = segmentSettings(timeline);
		const nextTimeline = new this.module.BrowserTimeline(
			JSON.stringify(timeline),
		);
		let nextTimes: BrowserRecordingTimes | null = null;
		let nextVisual: BrowserVisualConfig | null = null;
		try {
			nextTimes = new this.module.BrowserRecordingTimes(
				JSON.stringify(recordingMeta(this.sources)),
				JSON.stringify(record(config)?.clips ?? []),
			);
			nextVisual = new this.module.BrowserVisualConfig(JSON.stringify(config));
			await this.canvas.setProjectConfig(config);
		} catch (error) {
			nextTimeline.free();
			nextTimes?.free();
			nextVisual?.free();
			throw error;
		}
		this.frameController?.abort();
		this.frameSequence++;
		this.timeline.free();
		this.times.free();
		this.visual.free();
		this.timeline = nextTimeline;
		this.times = nextTimes;
		this.visual = nextVisual;
		this.segments = segments;
		this.audio.setConfig(config);
		this.canvas.resetFrameState();
		this.lastRequestedFrame = -1;
		if (this.previewBase) {
			this.resizeForBase(this.previewBase.width, this.previewBase.height);
		}
		await this.seek(this.outputTime);
	}

	resizeForBase(width: number, height: number) {
		const detail = previewDetailBase(this.visibleCanvas, width, height);
		const size = this.visual.output_dimensions(
			this.screenWidth,
			this.screenHeight,
			detail.width,
			detail.height,
		);
		if (size.length !== 2 || size[0] < 2 || size[1] < 2) {
			throw new Error("Editor output dimensions are unavailable");
		}
		this.previewBase = { width, height };
		const [visibleWidth, visibleHeight] = visiblePreviewSize(
			this.visibleCanvas,
			size[0],
			size[1],
			this.previewScale,
		);
		// The layout sizes the canvas from the frame's aspect, and even-pixel
		// rounding shifts that aspect slightly; ignoring few-pixel changes keeps
		// the two from resizing each other forever.
		if (
			Math.abs(this.width - visibleWidth) > 4 ||
			Math.abs(this.height - visibleHeight) > 4
		) {
			this.resize(visibleWidth, visibleHeight);
			return true;
		}
		return false;
	}

	resize(width: number, height: number) {
		if (this.width === width && this.height === height) return;
		this.frameController?.abort();
		this.frameSequence++;
		this.canvas.resizeCanvas(width, height);
		this.width = width;
		this.height = height;
		this.lastRequestedFrame = -1;
	}

	hasRenderedFrame() {
		return this.canvas.hasRenderedFrame();
	}

	resetFrameState() {
		this.canvas.resetFrameState();
	}

	captureFrame() {
		return this.canvas.captureFrame();
	}

	drawLatestFrameToCanvas(target: HTMLCanvasElement) {
		return this.canvas.drawLatestFrameToCanvas(target);
	}

	private speed(segmentIndex: number) {
		return this.segments[segmentIndex]?.timescale ?? 1;
	}

	private async syncAudio(
		recordingClip: number,
		segmentIndex: number,
		sourceTime: number,
		role: BrowserVideoRole,
		playing: boolean,
		fade: number,
		signal: AbortSignal,
	) {
		const videoTimes = this.times.source_times(recordingClip, sourceTime);
		const audioTimes = this.times.audio_times(recordingClip, sourceTime);
		if (videoTimes.length !== 2 || audioTimes.length !== 2) {
			throw new Error("Editor recording audio timing is unavailable");
		}
		const segment = this.segments[segmentIndex];
		if (!segment) throw new Error("Editor audio clip is unavailable");
		const enabled =
			segment.speedAudioMode !== "mute" &&
			(segment.timescale === 1 ||
				segment.speedAudioMode === "maintainPitch" ||
				segment.speedAudioMode === "matchSpeed");
		await this.audio.sync(
			recordingClip,
			role,
			videoTimes[0],
			audioTimes[0],
			audioTimes[1],
			playing,
			segment.timescale,
			segment.speedAudioMode,
			enabled,
			fade * segment.volume,
			signal,
		);
	}

	private async fallbackColorFix(url: string, signal: AbortSignal) {
		if (!navigator.userAgent.includes("Firefox/")) return false;
		let hint = this.colorHints.get(url);
		if (!hint) {
			hint = import("../../../apps/web/lib/browser-editor-metadata").then(
				({ probeBrowserEditorColor }) => probeBrowserEditorColor(url, signal),
			);
			this.colorHints.set(url, hint);
		}
		try {
			return await hint;
		} catch (cause) {
			this.colorHints.delete(url);
			if (signal.aborted) throw cause;
			return false;
		}
	}

	private async trackFrame(
		recordingClip: number,
		track: "display" | "camera",
		role: BrowserVideoRole,
		sourceTime: number,
		playing: boolean,
		speed: number,
		signal: AbortSignal,
		forceSeek: boolean,
	): Promise<TrackFrame | null> {
		if (
			this.screenWidth <= 1920 &&
			this.screenHeight <= 1080 &&
			typeof VideoDecoder === "function" &&
			typeof createImageBitmap === "function"
		) {
			const decoded = await this.decodedPool.frame(
				recordingClip,
				track,
				role,
				sourceTime,
				signal,
				playing && !forceSeek,
				this.width * 2,
				this.height * 2,
			);
			if (decoded === null) return null;
			if (decoded !== "fallback") {
				return {
					source: decoded.bitmap,
					width: decoded.width,
					height: decoded.height,
					mediaTime: decoded.mediaTime,
					release: () => decoded.bitmap.close(),
					sourceColorFix: decoded.sourceColorFix,
				};
			}
		}
		const video = await this.pool.frame(
			recordingClip,
			track,
			role,
			sourceTime,
			playing,
			speed,
			signal,
			forceSeek,
		);
		if (!video) return null;
		const sourceColorFix = await this.fallbackColorFix(
			video.currentSrc || video.src,
			signal,
		);
		const maxSourceWidth = this.width * 2;
		const maxSourceHeight = this.height * 2;
		const scale = Math.min(
			1,
			maxSourceWidth / video.videoWidth,
			maxSourceHeight / video.videoHeight,
		);
		if (scale < 1 && typeof createImageBitmap === "function") {
			try {
				const bitmap = await createImageBitmap(video, {
					resizeWidth: Math.max(2, Math.round(video.videoWidth * scale)),
					resizeHeight: Math.max(2, Math.round(video.videoHeight * scale)),
					resizeQuality: "medium",
				});
				if (signal.aborted) {
					bitmap.close();
					throw signal.reason ?? new DOMException("Canceled", "AbortError");
				}
				return {
					source: bitmap,
					width: bitmap.width,
					height: bitmap.height,
					mediaTime: video.currentTime,
					release: () => bitmap.close(),
					sourceColorFix,
				};
			} catch (cause) {
				if (signal.aborted) throw cause;
			}
		}
		return {
			source: video,
			width: video.videoWidth,
			height: video.videoHeight,
			mediaTime: video.currentTime,
			release: () => undefined,
			sourceColorFix,
		};
	}

	private async pair(
		recordingClip: number,
		segmentIndex: number,
		sourceTime: number,
		role: BrowserVideoRole,
		playing: boolean,
		signal: AbortSignal,
		forceSeek: boolean,
	): Promise<BrowserClipFrame> {
		const sourceTimes = this.times.source_times(recordingClip, sourceTime);
		if (sourceTimes.length !== 2 || !Number.isFinite(sourceTimes[0])) {
			throw new Error("Editor recording timing is unavailable");
		}
		const speed = this.speed(segmentIndex);
		const [screenResult, cameraResult] = await Promise.allSettled([
			this.trackFrame(
				recordingClip,
				"display",
				role,
				Math.max(0, sourceTimes[0]),
				playing,
				speed,
				signal,
				forceSeek,
			),
			Number.isFinite(sourceTimes[1]) && sourceTimes[1] >= 0
				? this.trackFrame(
						recordingClip,
						"camera",
						role,
						sourceTimes[1],
						playing,
						speed,
						signal,
						forceSeek,
					)
				: Promise.resolve(null),
		]);
		if (screenResult.status === "rejected") {
			if (cameraResult.status === "fulfilled") cameraResult.value?.release();
			throw screenResult.reason;
		}
		if (cameraResult.status === "rejected") {
			screenResult.value?.release();
			throw cameraResult.reason;
		}
		const screen = screenResult.value;
		const camera = cameraResult.value;
		if (!screen) {
			camera?.release();
			throw new Error("Editor display video is unavailable");
		}
		return {
			recordingClip,
			segmentTime: sourceTime,
			screen: {
				source: screen.source,
				colorFix: screen.sourceColorFix,
				mediaTime: screen.mediaTime,
				release: screen.release,
			},
			camera: camera
				? {
						source: camera.source,
						colorFix: camera.sourceColorFix,
						mediaTime: camera.mediaTime,
						release: camera.release,
					}
				: null,
		};
	}

	private async renderAt(time: number, playing: boolean, forceSeek = false) {
		this.frameController?.abort();
		const controller = new AbortController();
		this.frameController = controller;
		const sequence = ++this.frameSequence;
		const mapped = this.timeline.map_frame(time);
		if (mapped.length !== 11) return false;
		const kind = mapped[0];
		const incomingClip = mapped[2];
		const incomingSegment = mapped[1];
		if (
			!Number.isSafeInteger(incomingClip) ||
			!Number.isSafeInteger(incomingSegment) ||
			incomingClip < 0 ||
			incomingSegment < 0
		) {
			throw new Error("Editor timeline clip mapping is invalid");
		}
		const transition = kind === 2;
		const outgoingClip = transition ? mapped[5] : null;
		if (
			transition &&
			(outgoingClip === null ||
				!Number.isSafeInteger(outgoingClip) ||
				outgoingClip < 0 ||
				!Number.isSafeInteger(mapped[4]) ||
				mapped[4] < 0)
		) {
			throw new Error("Editor transition mapping is invalid");
		}
		this.pool.retainSegments(incomingClip, outgoingClip);
		this.decodedPool.retainSegments(incomingClip, outgoingClip);
		const incoming = this.pair(
			incomingClip,
			incomingSegment,
			mapped[3],
			"primary",
			playing,
			controller.signal,
			forceSeek,
		);
		const outgoing =
			transition && outgoingClip !== null
				? this.pair(
						outgoingClip,
						mapped[4],
						mapped[6],
						"overlap",
						playing,
						controller.signal,
						forceSeek,
					)
				: Promise.resolve(null);
		let incomingPair: BrowserClipFrame;
		let outgoingPair: BrowserClipFrame | null;
		const [incomingResult, outgoingResult] = await Promise.allSettled([
			incoming,
			outgoing,
		]);
		if (incomingResult.status === "rejected") {
			if (outgoingResult.status === "fulfilled")
				releasePair(outgoingResult.value);
			if (controller.signal.aborted) return null;
			throw incomingResult.reason;
		}
		if (outgoingResult.status === "rejected") {
			releasePair(incomingResult.value);
			if (controller.signal.aborted) return null;
			throw outgoingResult.reason;
		}
		incomingPair = incomingResult.value;
		outgoingPair = outgoingResult.value;
		if (controller.signal.aborted || sequence !== this.frameSequence) {
			releasePair(incomingPair);
			releasePair(outgoingPair);
			return null;
		}
		try {
			await this.canvas.render(
				outgoingPair
					? {
							kind: "transition",
							outgoing: outgoingPair,
							incoming: incomingPair,
							type: mapped[8] === 1 ? "fade-through-black" : "cross-fade",
							progress: mapped[9],
						}
					: { kind: "single", frame: incomingPair },
				Math.round(time * 60),
				BigInt(Math.round(time * 1_000_000_000)),
			);
		} finally {
			releasePair(incomingPair);
			releasePair(outgoingPair);
		}
		if (!transition) {
			this.pool.releaseOverlaps();
			this.decodedPool.releaseOverlaps();
			this.audio.releaseOverlaps();
		}
		const progress = Math.max(0, Math.min(mapped[9], 1));
		const fadeThroughBlack = mapped[8] === 1;
		const incomingGain = transition
			? fadeThroughBlack
				? Math.max(progress * 2 - 1, 0)
				: Math.sin((progress * Math.PI) / 2)
			: 1;
		const outgoingGain = fadeThroughBlack
			? Math.max(1 - progress * 2, 0)
			: Math.cos((progress * Math.PI) / 2);
		const sync = (
			clip: number,
			segment: number,
			sourceTime: number,
			role: BrowserVideoRole,
			gain: number,
		) => {
			void this.syncAudio(
				clip,
				segment,
				sourceTime,
				role,
				playing,
				gain,
				controller.signal,
			).catch((cause: unknown) => {
				if (controller.signal.aborted || this.disposed) return;
				this.onError(cause instanceof Error ? cause : new Error(String(cause)));
			});
		};
		sync(incomingClip, incomingSegment, mapped[3], "primary", incomingGain);
		if (transition && outgoingClip !== null) {
			sync(outgoingClip, mapped[4], mapped[6], "overlap", outgoingGain);
		}
		if (playing && !this.playClockAligned && this.playing) {
			this.playClockAligned = true;
			const sourceTime = this.times.source_times(incomingClip, mapped[3])[0];
			const drift =
				(incomingPair.screen.mediaTime - sourceTime) /
				this.speed(incomingSegment);
			if (Number.isFinite(drift)) {
				this.playStartedAt = performance.now();
				this.playStartedTime = time + Math.max(-0.05, Math.min(drift, 0.05));
			}
		}
		this.outputTime = time;
		return true;
	}

	private samplePlaybackFrameCost(elapsedMs: number, now = performance.now()) {
		if (!this.previewBase || !this.playing) return;
		const cost = Math.max(
			elapsedMs,
			this.lastRenderedAt > 0 ? now - this.lastRenderedAt : elapsedMs,
		);
		this.lastRenderedAt = now;
		this.averageFrameCostMs =
			this.averageFrameCostMs === 0
				? cost
				: this.averageFrameCostMs * 0.85 + cost * 0.15;
		this.slowFrames =
			this.averageFrameCostMs > (this.previewScale === 1 ? 21 : 32)
				? this.slowFrames + 1
				: 0;
		this.fastFrames =
			elapsedMs < 13 &&
			this.averageFrameCostMs < (this.previewScale === 1 ? 21 : 32)
				? this.fastFrames + 1
				: 0;
		let nextScale: 1 | 0.75 | 0.5 = this.previewScale;
		if (this.slowFrames >= 18) {
			nextScale = this.previewScale === 1 ? 0.75 : 0.5;
		} else if (this.fastFrames >= 180) {
			nextScale = this.previewScale === 0.5 ? 0.75 : 1;
		}
		if (nextScale === this.previewScale) return;
		this.previewScale = nextScale;
		this.averageFrameCostMs = 0;
		this.lastRenderedAt = 0;
		this.slowFrames = 0;
		this.fastFrames = 0;
		this.resizeForBase(this.previewBase.width, this.previewBase.height);
	}

	async seek(time: number) {
		if (this.disposed) throw new Error("Editor playback is closed");
		if (!Number.isFinite(time) || time < 0) {
			throw new Error("Editor playback time is invalid");
		}
		this.outputTime = time;
		if (this.playing) {
			this.playStartedAt = performance.now();
			this.playStartedTime = time;
			this.playClockAligned = false;
		}
		return this.renderAt(time, this.playing, true);
	}

	play() {
		if (this.disposed) throw new Error("Editor playback is closed");
		if (this.playing) return;
		this.audio.resume();
		this.playing = true;
		this.playStartedAt = performance.now();
		this.playStartedTime = this.outputTime;
		this.lastRequestedFrame = -1;
		this.playClockAligned = false;
		this.averageFrameCostMs = 0;
		this.lastRenderedAt = 0;
		this.slowFrames = 0;
		this.fastFrames = 0;
		let firstTick = true;
		const tick = () => {
			if (!this.playing || this.disposed) return;
			this.animationFrame = requestAnimationFrame(tick);
			if (this.frameBusy) return;
			if (firstTick) {
				this.playStartedAt = performance.now();
				firstTick = false;
			}
			const time =
				this.playStartedTime + (performance.now() - this.playStartedAt) / 1000;
			const frame = Math.floor(time * 60);
			if (frame === this.lastRequestedFrame) return;
			this.lastRequestedFrame = frame;
			this.frameBusy = true;
			const started = performance.now();
			void this.renderAt(time, true)
				.then((rendered) => {
					if (rendered === false) this.pause();
					else if (rendered === true)
						this.samplePlaybackFrameCost(performance.now() - started);
				})
				.catch((cause: unknown) => {
					if (cause instanceof DOMException && cause.name === "AbortError") {
						return;
					}
					this.pause();
					this.onError(
						cause instanceof Error ? cause : new Error(String(cause)),
					);
				})
				.finally(() => {
					this.frameBusy = false;
				});
		};
		this.animationFrame = requestAnimationFrame(tick);
	}

	pause() {
		if (!this.playing) return;
		this.playing = false;
		cancelAnimationFrame(this.animationFrame);
		this.pool.pause();
		this.audio.pause();
		// Playback may have lowered the resolution to keep up; a paused frame
		// always renders at full detail.
		if (this.previewScale !== 1) {
			this.previewScale = 1;
			this.averageFrameCostMs = 0;
			this.lastRenderedAt = 0;
			this.slowFrames = 0;
			this.fastFrames = 0;
			if (this.previewBase) {
				this.resizeForBase(this.previewBase.width, this.previewBase.height);
			}
			void this.seek(this.outputTime).catch((cause: unknown) => {
				if (this.disposed) return;
				this.onError(cause instanceof Error ? cause : new Error(String(cause)));
			});
		}
	}

	dispose() {
		if (this.disposed) return;
		this.pause();
		this.disposed = true;
		this.frameController?.abort();
		this.canvas.dispose();
		this.audio.dispose();
		this.pool.dispose();
		this.decodedPool.dispose();
		this.catalog.dispose();
		this.timeline.free();
		this.times.free();
		this.visual.free();
	}
}
