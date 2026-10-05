import { applyDefaultStyle } from "@cap/editor-cap-bundle/default-style";
import { reportPlaybackBuffering } from "../../../apps/desktop/src/routes/editor/playback-buffering";
import type {
	BrowserRecordingTimes,
	BrowserTimeline,
	BrowserVisualConfig,
} from "../renderer/pkg/cap_editor_browser_renderer.js";
import { browserAudioLevelSources } from "./browser-audio-levels";
import { BrowserAudioPlayback } from "./browser-audio-playback";
import {
	BrowserDecodedVideoPool,
	MAX_DECODED_PIXELS,
} from "./browser-decoded-video-pool";
import {
	type BrowserClipFrame,
	BrowserLocalCanvas,
	type BrowserRenderedFrame,
	type BrowserStudioSetup,
} from "./browser-local-canvas";
import { probeBrowserMedia } from "./browser-media-probe";
import { whenMediaReadsIdle } from "./browser-network-budget";
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
import {
	perfCount,
	perfEvent,
	perfMark,
	perfSpan,
	perfStart,
} from "./editor-perf";

type RendererModule = Awaited<ReturnType<typeof loadBrowserRenderer>>;

type TimelineSegment = {
	recordingSegment: number;
	timescale: number;
	speedAudioMode: "maintainPitch" | "matchSpeed" | "mute" | null;
	volume: number;
};

type TrackFrame = {
	source: HTMLVideoElement | ImageBitmap | VideoFrame;
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

/// Resolves once the page has laid out and delivered resize observations,
/// so a canvas mounted in the same turn has the size its layout gives it and
/// the first frame isn't drawn at a stale size and then redrawn. Falls back
/// to a timer where animation frames don't run (a hidden tab).
function layoutSettled() {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, 100);
		requestAnimationFrame(() =>
			setTimeout(() => {
				clearTimeout(timer);
				resolve();
			}, 0),
		);
	});
}

/// The desktop preview quality presets size frames for a fixed 1080p output.
/// In the browser, Full renders at the canvas's real device-pixel size
/// (capped at 4K), Half at half of it and Quarter at a quarter, never above
/// its own low preset, so a smaller preset never renders more pixels.
export function previewDetailBase(
	canvas: Pick<HTMLCanvasElement, "getBoundingClientRect">,
	width: number,
	height: number,
	density = window.devicePixelRatio,
) {
	const bounds = canvas.getBoundingClientRect();
	if (bounds.width < 2 || bounds.height < 2 || !(density > 0)) {
		return { width, height };
	}
	const quarter = width < 960;
	const fraction = width >= 1920 ? 1 : quarter ? 0.25 : 0.5;
	const scale = Math.min(
		fraction *
			Math.max(
				(bounds.width * density) / width,
				(bounds.height * density) / height,
			),
		quarter ? 1 : 3840 / width,
		quarter ? 1 : 2160 / height,
	);
	return {
		width: Math.max(2, Math.round(width * scale)),
		height: Math.max(2, Math.round(height * scale)),
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

export type MotionRanges = { always: boolean; ranges: Array<[number, number]> };

const SCRUB_SEEK_GAP_MS = 150;
const SCRUB_REFINE_MS = 40;
const KEY_FRAME_TIME_OFFSET = 0.002;

const PLAYBACK_SCALE_SETTLED_MS = 3000;
/// A playing frame still not drawn after this long is waiting on its media:
/// playback holds, audio included, and carries on from that frame instead of
/// skipping what it missed.
const STALL_MS = 300;
/// A paused frame (a seek, or a redraw after an edit) still not drawn after
/// this long is waiting on its media too, and is shown as loading.
const SEEK_HOLD_MS = 250;
const FIRST_FRAME_ATTEMPTS = 3;
/// A loading paused frame gives way to a newer request only once requests
/// have stopped this long: a scrub asks for a new time every few
/// milliseconds and shows each frame as it finishes, so giving way mid-scrub
/// would leave the preview blank until the drag ends.
const SEEK_SETTLE_MS = 150;
/// While paused, the media this far past the playhead is read ahead once
/// nothing else is loading, so Play starts on loaded media even when the
/// recording's bitrate is above the connection's.
const BUFFER_AHEAD_SECONDS = 8;
/// While playing, how long a drawn screen frame waits for its camera frame
/// before showing the camera's last frame instead. A camera that can't keep
/// up (often several times the screen's bitrate) holds its picture until its
/// media arrives rather than holding the whole preview.
const CAMERA_GRACE_MS = 120;
/// The same wait for a paused frame, which then redraws once its camera
/// frame lands; long enough that a camera decoding normally is never shown
/// out of step.
const PAUSED_CAMERA_GRACE_MS = 400;

/// Zoom springs keep settling after a zoom segment ends.
const ZOOM_SETTLE_SECS = 3;
const OVERLAY_MARGIN_SECS = 1;

/// Where the preview changes over time even while the recording's frames stay
/// the same: every timed timeline item except clips and audio (zooms, scenes,
/// overlays, style changes), captions, and anything animated throughout (a
/// moving background, film grain, a recorded cursor). Elsewhere a later frame
/// only looks different once a source frame changes.
export function motionRanges(
	config: unknown,
	hasCursor: boolean,
): MotionRanges {
	const project = record(config);
	const source = record(record(project?.background)?.source);
	const grades = record(project?.colorCorrection);
	const graded = [grades?.screen, grades?.camera].some((value) => {
		const grade = record(value);
		return (
			grade !== null &&
			((typeof grade.preset === "string" && grade.preset !== "none") ||
				numeric(grade.grain, 0) !== 0)
		);
	});
	const always =
		source?.type === "animatedGradient" ||
		(source?.type === "gradient" && source.animated === true) ||
		graded ||
		(hasCursor && record(project?.cursor)?.hide !== true);
	const ranges: Array<[number, number]> = [];
	const timeline = record(project?.timeline);
	const add = (items: unknown, before: number, after: number) => {
		if (!Array.isArray(items)) return items !== undefined && items !== null;
		for (const value of items) {
			const item = record(value);
			const start = item?.start;
			const end = item?.end;
			if (typeof start !== "number" || typeof end !== "number") return true;
			ranges.push([start - before, end + after]);
		}
		return false;
	};
	let unknown = false;
	for (const [key, items] of Object.entries(timeline ?? {})) {
		if (key === "segments" || key === "transitions" || key === "audioSegments")
			continue;
		unknown =
			add(
				items,
				OVERLAY_MARGIN_SECS,
				key === "zoomSegments" ? ZOOM_SETTLE_SECS : OVERLAY_MARGIN_SECS,
			) || unknown;
	}
	unknown =
		add(
			record(project?.captions)?.segments,
			OVERLAY_MARGIN_SECS,
			OVERLAY_MARGIN_SECS,
		) || unknown;
	ranges.sort((a, b) => a[0] - b[0]);
	const merged: Array<[number, number]> = [];
	for (const range of ranges) {
		const last = merged[merged.length - 1];
		if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
		else merged.push([range[0], range[1]]);
	}
	return { always: always || unknown, ranges: merged };
}

export function inMotion(motion: MotionRanges, time: number) {
	if (motion.always) return true;
	let lo = 0;
	let hi = motion.ranges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const range = motion.ranges[mid];
		if (!range) return true;
		if (time < range[0]) hi = mid - 1;
		else if (time > range[1]) lo = mid + 1;
		else return true;
	}
	return false;
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
	/// A play that stayed at full resolution for less than
	/// PLAYBACK_SCALE_SETTLED_MS ended before it could have stepped down, so it
	/// doesn't reset where the next play starts.
	private playbackScale: 1 | 0.75 | 0.5 = 1;
	private playbackBegan = 0;
	private averageFrameCostMs = 0;
	private lastRenderedAt = 0;
	private playClockAligned = false;
	private stalled = false;
	private renderStartedAt = 0;
	private awaitingPlayingFrame = false;
	private seekHeld = false;
	private seekHoldShown = false;
	private seekHoldTimer: ReturnType<typeof setTimeout> | undefined;
	private seekSettleTimer: ReturnType<typeof setTimeout> | undefined;
	private lastSeekRequestAt = 0;
	private bufferController: AbortController | null = null;
	private audioClockAligned = false;
	private audioOffsets: number[] = [];
	private configJson: string;
	private slowFrames = 0;
	private slowStreakMs = 0;
	private fastFrames = 0;
	private pendingSeek: number | null = null;
	private seeking: Promise<boolean | null> | null = null;
	private renderedTime = -1;
	private scrubbing = false;
	private drawingSeek: number | null = null;
	private lastKeyFrameAt = 0;
	private refineTimer: ReturnType<typeof setTimeout> | undefined;
	private motion: MotionRanges;
	private drawnFrameKey: string | null = null;
	private heldCamera: {
		clip: number;
		frame: VideoFrame;
		width: number;
		height: number;
		mediaTime: number;
		sourceColorFix: boolean;
	} | null = null;
	private lateCamera: Promise<unknown> | null = null;
	/// Bumped whenever the playhead jumps (a seek, play, pause or new config),
	/// so a camera frame that arrives late for an earlier position is
	/// dropped instead of replacing the held one.
	private cameraGeneration = 0;
	/// Aborted when playback stops; a late camera frame outlives the frame
	/// that asked for it.
	private playController: AbortController | null = null;
	private lastRenderRepeated = false;
	private settleResizes = 0;

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
		private readonly hasCursor: boolean,
	) {
		const timeline = timelineConfig(config, sourceDurations);
		this.segments = segmentSettings(timeline);
		this.timeline = new module.BrowserTimeline(JSON.stringify(timeline));
		this.times = new module.BrowserRecordingTimes(
			JSON.stringify(recordingMeta(sources)),
			JSON.stringify(record(config)?.clips ?? []),
		);
		this.configJson = JSON.stringify(config);
		this.visual = new module.BrowserVisualConfig(this.configJson);
		this.motion = motionRanges(config, hasCursor);
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
		const laidOut = width === 0 && height === 0 ? layoutSettled() : null;
		try {
			const signal = controller.signal;
			const [sources, module] = await Promise.all([
				catalog.snapshot(signal).finally(() => perfMark("sources")),
				loadBrowserRenderer().finally(() => perfMark("renderer-module")),
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
				perfMark("media-probed");
				return { display, camera, mic };
			})();
			const [metadata, input] = await Promise.all([
				metadataPromise,
				webInputRecording(sources, module, signal).finally(() =>
					perfMark("input-recording"),
				),
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
			// The same starting config the editor state uses, saved style and
			// all, so the first preview frame matches the sidebar.
			const defaults: unknown = JSON.parse(
				module.default_project_config_json(),
			);
			const config =
				sources.projectConfig ??
				(sources.defaultStyle &&
				typeof defaults === "object" &&
				defaults !== null &&
				!Array.isArray(defaults)
					? applyDefaultStyle(
							defaults as Record<string, unknown>,
							sources.defaultStyle,
						)
					: defaults);
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
				await laidOut;
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
				audio: browserAudioLevelSources(sources),
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
				input !== null,
			);
			await controls.setProjectConfig(config);
			perfMark("renderer-ready");
			await playback.seek(
				Math.min(initialTime, Math.max(0, recordingDuration - 1 / 60)),
			);
			perfMark("first-frame");
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
		const json = JSON.stringify(config);
		if (json === this.configJson) return;
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
			nextVisual = new this.module.BrowserVisualConfig(json);
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
		this.configJson = json;
		this.motion = motionRanges(config, this.hasCursor);
		this.drawnFrameKey = null;
		this.jumpCamera();
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
		const offWidth = Math.abs(this.width - visibleWidth);
		const offHeight = Math.abs(this.height - visibleHeight);
		// The layout sizes the canvas from the frame's aspect, and even-pixel
		// rounding shifts that aspect slightly; ignoring few-pixel changes keeps
		// the two from resizing each other forever.
		if (offWidth > 4 || offHeight > 4) {
			this.settleResizes = 0;
			this.resize(visibleWidth, visibleHeight);
			return true;
		}
		// Within those few pixels the canvas can still be scaled a little from
		// its box, which blurs it, so it matches the box itself, whose aspect
		// the layout already uses, at most twice in a row.
		const box = this.settleResizes < 2 ? this.boxSize() : null;
		if (
			box &&
			(box[0] !== this.width || box[1] !== this.height) &&
			Math.abs(box[0] - this.width) <= 4 &&
			Math.abs(box[1] - this.height) <= 4
		) {
			this.settleResizes++;
			this.resize(box[0], box[1]);
			return true;
		}
		return false;
	}

	/// The backing size that matches the canvas's box pixel for pixel at the
	/// detail the preview is drawing, or null when the box isn't laid out.
	private boxSize() {
		if (!this.previewBase) return null;
		const bounds = this.visibleCanvas.getBoundingClientRect();
		const density = window.devicePixelRatio;
		if (bounds.width < 2 || bounds.height < 2 || !(density > 0)) return null;
		const detail = previewDetailBase(
			this.visibleCanvas,
			this.previewBase.width,
			this.previewBase.height,
		);
		const size = this.visual.output_dimensions(
			this.screenWidth,
			this.screenHeight,
			detail.width,
			detail.height,
		);
		if (size.length !== 2 || size[0] < 2 || size[1] < 2) return null;
		const [width, height] = visiblePreviewSize(
			this.visibleCanvas,
			size[0],
			size[1],
			this.previewScale,
		);
		const boxWidth = bounds.width * density;
		const boxHeight = bounds.height * density;
		const detailScale = Math.max(width / boxWidth, height / boxHeight);
		return [
			Math.max(2, Math.round((boxWidth * detailScale) / 2) * 2),
			Math.max(2, Math.round((boxHeight * detailScale) / 2) * 2),
		] as const;
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
		const lag = await this.audio.sync(
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
		return lag === null ? null : lag / segment.timescale;
	}

	/// Audio starts a few tens of milliseconds after the first frame. Once it
	/// has run for a few frames, the video clock moves onto it so the two
	/// stay in step for the rest of playback.
	private followAudio(lag: number | null, time: number) {
		if (lag !== null && this.playing && this.audioOffsets.length === 0)
			perfEvent("audio.moving");
		if (lag === null || !this.playing || this.audioClockAligned) return;
		const clock =
			this.playStartedTime + (performance.now() - this.playStartedAt) / 1000;
		this.audioOffsets.push(clock - (time - lag));
		if (this.audioOffsets.length < 12) return;
		this.audioClockAligned = true;
		const offset = this.audioOffsets.sort((a, b) => a - b)[6] ?? 0;
		if (Math.abs(offset) > 0.01 && Math.abs(offset) < 0.3) {
			this.playStartedTime -= offset;
		}
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
		keyFrame = false,
	): Promise<TrackFrame | null> {
		if (
			this.screenWidth * this.screenHeight <= MAX_DECODED_PIXELS &&
			typeof VideoDecoder === "function"
		) {
			const decoded = await this.decodedPool.frame(
				recordingClip,
				track,
				role,
				sourceTime,
				signal,
				keyFrame,
			);
			if (decoded === null) return null;
			if (decoded !== "fallback") {
				return {
					source: decoded.frame,
					width: decoded.width,
					height: decoded.height,
					mediaTime: decoded.mediaTime,
					release: () => decoded.frame.close(),
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

	private holdCamera(clip: number, frame: TrackFrame | null) {
		if (
			frame &&
			typeof VideoFrame === "function" &&
			frame.source instanceof VideoFrame &&
			!this.disposed
		) {
			this.heldCamera?.frame.close();
			this.heldCamera = {
				clip,
				frame: frame.source.clone(),
				width: frame.width,
				height: frame.height,
				mediaTime: frame.mediaTime,
				sourceColorFix: frame.sourceColorFix,
			};
		}
		return frame;
	}

	/// The camera frame for a playing frame: its own once decoded, or the
	/// camera's last frame when it is still loading `CAMERA_GRACE_MS` after
	/// the screen frame (at once while an earlier one is still loading). The
	/// late frame becomes the held one when it arrives, so the camera catches
	/// up in steps at the right times and never runs behind the screen.
	private async cameraOrHeld(
		clip: number,
		screen: Promise<TrackFrame | null>,
		camera: Promise<TrackFrame | null>,
		playing = true,
		graceMs = CAMERA_GRACE_MS,
		onLate?: () => void,
	): Promise<TrackFrame | null> {
		const held = this.heldCamera;
		if (!held || held.clip !== clip) {
			return camera.then((frame) => this.holdCamera(clip, frame));
		}
		const generation = this.cameraGeneration;
		const ready = camera.then((frame) => ({ frame }));
		const result = await Promise.race([
			ready,
			screen.then(
				() =>
					new Promise<null>((resolve) =>
						setTimeout(() => resolve(null), graceMs),
					),
				() => null,
			),
		]);
		if (result) return this.holdCamera(clip, result.frame);
		perfCount("camera.held");
		perfEvent("camera.held");
		const late = ready.then(
			({ frame }) => {
				if (generation === this.cameraGeneration) {
					this.holdCamera(clip, frame);
					onLate?.();
				}
				frame?.release();
			},
			() => undefined,
		);
		if (!playing) return this.heldCameraFrame();
		this.lateCamera = late;
		void late.finally(() => {
			if (this.lateCamera === late) this.lateCamera = null;
		});
		return this.heldCameraFrame();
	}

	private redrawPaused() {
		if (this.playing || this.disposed) return;
		this.renderedTime = -1;
		void this.seek(this.outputTime).catch((cause: unknown) => {
			if (this.disposed) return;
			this.onError(cause instanceof Error ? cause : new Error(String(cause)));
		});
	}

	private jumpCamera() {
		this.cameraGeneration++;
		this.lateCamera = null;
	}

	private heldCameraFrame(): TrackFrame | null {
		const held = this.heldCamera;
		if (!held) return null;
		const frame = held.frame.clone();
		return {
			source: frame,
			width: held.width,
			height: held.height,
			mediaTime: held.mediaTime,
			release: () => frame.close(),
			sourceColorFix: held.sourceColorFix,
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
		keyFrame = false,
	): Promise<BrowserClipFrame> {
		const sourceTimes = this.times.source_times(recordingClip, sourceTime);
		if (sourceTimes.length !== 2 || !Number.isFinite(sourceTimes[0])) {
			throw new Error("Editor recording timing is unavailable");
		}
		const speed = this.speed(segmentIndex);
		const started = perfStart();
		const screenFrame = this.trackFrame(
			recordingClip,
			"display",
			role,
			Math.max(0, sourceTimes[0]),
			playing,
			speed,
			signal,
			forceSeek,
			keyFrame,
		).finally(() => perfSpan("decode.display", started));
		const hasCamera = Number.isFinite(sourceTimes[1]) && sourceTimes[1] >= 0;
		const generation = this.cameraGeneration;
		const playSignal =
			playing && !forceSeek && role === "primary"
				? this.playController?.signal
				: undefined;
		let cameraPending: Promise<TrackFrame | null>;
		if (!hasCamera) cameraPending = Promise.resolve(null);
		else if (
			playSignal &&
			this.lateCamera &&
			this.heldCamera?.clip === recordingClip
		) {
			// The camera is still loading an earlier frame; it shows its last
			// one until that arrives.
			cameraPending = Promise.resolve(this.heldCameraFrame());
		} else {
			const cameraFrame = this.trackFrame(
				recordingClip,
				"camera",
				role,
				sourceTimes[1],
				playing,
				speed,
				playSignal ?? signal,
				forceSeek,
				keyFrame,
			).finally(() => perfSpan("decode.camera", started));
			// A scrub shows the screen moving with the camera's last frame; the
			// exact frame drawn once it settles waits for both.
			cameraPending =
				playSignal || (keyFrame && role === "primary")
					? this.cameraOrHeld(
							recordingClip,
							screenFrame,
							cameraFrame,
							!!playSignal,
						)
					: role === "primary" && this.canvas.hasRenderedFrame()
						? // A paused frame waiting on a camera fragment shows the screen
							// at once and redraws when the camera catches up.
							this.cameraOrHeld(
								recordingClip,
								screenFrame,
								cameraFrame,
								false,
								PAUSED_CAMERA_GRACE_MS,
								() => this.redrawPaused(),
							)
						: role === "primary"
							? cameraFrame.then((frame) =>
									generation === this.cameraGeneration
										? this.holdCamera(recordingClip, frame)
										: frame,
								)
							: cameraFrame;
		}
		const [screenResult, cameraResult] = await Promise.allSettled([
			screenFrame,
			cameraPending,
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

	private async renderAt(
		time: number,
		playing: boolean,
		forceSeek = false,
		keyFrame = false,
	) {
		const started = perfStart();
		this.frameController?.abort();
		const controller = new AbortController();
		this.frameController = controller;
		const sequence = ++this.frameSequence;
		// The renderer keeps the frame it last uploaded while the recording time
		// repeats, so a key frame is drawn a hair later than its time and the
		// exact frame that replaces it still uploads.
		const mapped = this.timeline.map_frame(
			keyFrame ? time + KEY_FRAME_TIME_OFFSET : time,
		);
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
			keyFrame,
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
						keyFrame,
					)
				: Promise.resolve(null);
		let incomingPair: BrowserClipFrame;
		let outgoingPair: BrowserClipFrame | null;
		const decoded = Promise.allSettled([incoming, outgoing]);
		// An abandoned frame stops waiting at once; its decodes finish on
		// their own and their frames are released.
		const settled = await Promise.race([
			decoded,
			new Promise<null>((resolve) => {
				if (controller.signal.aborted) resolve(null);
				controller.signal.addEventListener("abort", () => resolve(null), {
					once: true,
				});
			}),
		]);
		if (settled === null) {
			void decoded.then((results) => {
				for (const result of results)
					if (result.status === "fulfilled") releasePair(result.value);
			});
			return null;
		}
		const [incomingResult, outgoingResult] = settled;
		perfSpan("frame.decode", started);
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
		// A 30 fps recording plays on a 60 Hz loop, so every other frame shows
		// the same source frames and, unless something on the timeline moves,
		// would draw the same pixels again.
		const frameKey =
			playing && !transition
				? `${incomingPair.recordingClip}:${incomingPair.screen.mediaTime}:${incomingPair.camera?.mediaTime ?? "-"}`
				: null;
		const repeated =
			frameKey !== null &&
			frameKey === this.drawnFrameKey &&
			!inMotion(this.motion, time) &&
			this.canvas.repeatFrame(
				Math.round(time * 60),
				BigInt(Math.round(time * 1_000_000_000)),
			);
		this.lastRenderRepeated = repeated;
		const drawStarted = perfStart();
		if (repeated) {
			releasePair(incomingPair);
			perfCount("frame.repeated");
		} else {
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
			this.drawnFrameKey = frameKey;
		}
		perfSpan("frame.draw", drawStarted);
		perfSpan(playing ? "frame.playing" : "frame.paused", started);
		perfEvent(`frame ${playing ? "playing" : "paused"} ${time.toFixed(3)}`);
		this.renderedTime = keyFrame ? -1 : time;
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
			).then(
				(lag) => {
					if (role === "primary" && !controller.signal.aborted) {
						this.followAudio(lag, time);
					}
				},
				(cause: unknown) => {
					if (controller.signal.aborted || this.disposed) return;
					this.onError(
						cause instanceof Error ? cause : new Error(String(cause)),
					);
				},
			);
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
		if (this.lastRenderRepeated) {
			this.lastRenderedAt = now;
			return;
		}
		const cost = Math.max(
			elapsedMs,
			this.lastRenderedAt > 0 ? now - this.lastRenderedAt : elapsedMs,
		);
		this.lastRenderedAt = now;
		this.averageFrameCostMs =
			this.averageFrameCostMs === 0
				? cost
				: this.averageFrameCostMs * 0.85 + cost * 0.15;
		const budget = this.previewScale === 1 ? 21 : 32;
		const slow = this.averageFrameCostMs > budget;
		this.slowFrames = slow ? this.slowFrames + 1 : 0;
		this.slowStreakMs = slow ? this.slowStreakMs + elapsedMs : 0;
		this.fastFrames =
			elapsedMs < 13 && this.averageFrameCostMs < budget
				? this.fastFrames + 1
				: 0;
		let nextScale: 1 | 0.75 | 0.5 = this.previewScale;
		// A software GPU can take a second or more to draw a frame, where 18
		// frames would leave the preview stuck at full size for most of a
		// minute. Only drawing time counts, so a stall between frames doesn't.
		if (
			this.slowFrames >= 18 ||
			(this.slowFrames >= 2 && this.slowStreakMs >= 1000)
		) {
			nextScale = this.previewScale === 1 ? 0.75 : 0.5;
		} else if (this.fastFrames >= 180) {
			nextScale = this.previewScale === 0.5 ? 0.75 : 1;
		}
		if (nextScale === this.previewScale) return;
		this.previewScale = nextScale;
		this.averageFrameCostMs = 0;
		this.lastRenderedAt = 0;
		this.slowFrames = 0;
		this.slowStreakMs = 0;
		this.fastFrames = 0;
		this.resizeForBase(this.previewBase.width, this.previewBase.height);
	}

	async seek(time: number) {
		if (this.disposed) throw new Error("Editor playback is closed");
		this.jumpCamera();
		if (!Number.isFinite(time) || time < 0) {
			throw new Error("Editor playback time is invalid");
		}
		this.outputTime = time;
		if (this.playing) {
			this.playStartedAt = performance.now();
			this.playStartedTime = time;
			this.playClockAligned = false;
			this.audioClockAligned = false;
			this.audioOffsets = [];
			return this.renderAt(time, true, true);
		}
		clearTimeout(this.refineTimer);
		// A new time while one is still drawing means the requests are outrunning
		// the preview. The timeline asks for each time twice, so a repeat of the
		// one drawing or waiting doesn't count.
		if (
			this.seeking &&
			time !== this.drawingSeek &&
			time !== this.pendingSeek
		) {
			this.scrubbing = true;
		}
		this.bufferController?.abort();
		this.pendingSeek = time;
		if (this.seeking) {
			this.lastSeekRequestAt = performance.now();
			clearTimeout(this.seekSettleTimer);
			this.seekSettleTimer = setTimeout(
				() => this.abandonHeldSeek(),
				SEEK_SETTLE_MS,
			);
			return this.seeking;
		}
		if (time === this.renderedTime && this.canvas.hasRenderedFrame()) {
			this.pendingSeek = null;
			return true;
		}
		this.scrubbing &&=
			performance.now() - this.lastKeyFrameAt < SCRUB_SEEK_GAP_MS;
		this.seeking = this.drainSeeks();
		return this.seeking;
	}

	/// Paused seeks never cancel the frame being drawn: scrubbing asks for a
	/// new time on every pointer move, faster than a frame can decode, so the
	/// preview shows each finished frame and then jumps to the latest request.
	/// Once the requests outrun it, a frame shows the key frame at or before
	/// its time, one decode instead of up to a key interval of them, and the
	/// exact frame follows once the playhead rests. Seeks that wait for each
	/// other always draw exactly.
	private async drainSeeks() {
		let result: boolean | null = null;
		let keyFrame = false;
		try {
			while (this.pendingSeek !== null && !this.playing && !this.disposed) {
				const time = this.pendingSeek;
				this.pendingSeek = null;
				if (time === this.renderedTime && this.canvas.hasRenderedFrame()) {
					result = true;
					continue;
				}
				keyFrame = this.scrubbing;
				this.drawingSeek = time;
				this.holdForSeek(true);
				try {
					result = await this.firstFrameRetried(() =>
						this.renderAt(time, false, true, keyFrame),
					);
				} finally {
					this.holdForSeek(false);
				}
				if (keyFrame) this.lastKeyFrameAt = performance.now();
			}
			return result;
		} finally {
			this.seeking = null;
			this.drawingSeek = null;
			if (result === true && !keyFrame) this.bufferAhead(this.outputTime);
			if (keyFrame && !this.playing && !this.disposed) {
				this.refineTimer = setTimeout(() => {
					if (this.playing || this.disposed || this.seeking) return;
					this.scrubbing = false;
					this.pendingSeek = this.outputTime;
					this.seeking = this.drainSeeks();
					this.seeking.catch((cause: unknown) => {
						if (this.disposed) return;
						this.onError(
							cause instanceof Error ? cause : new Error(String(cause)),
						);
					});
				}, SCRUB_REFINE_MS);
			}
		}
	}

	play() {
		if (this.disposed) throw new Error("Editor playback is closed");
		if (this.playing) return;
		perfEvent("play");
		this.jumpCamera();
		this.bufferController?.abort();
		this.playController?.abort();
		this.playController = new AbortController();
		this.audio.resume();
		this.playing = true;
		// Play pressed before this preview existed was already shown as
		// buffering; the first frame drawn ends that.
		this.awaitingPlayingFrame = true;
		this.holdForSeek(false);
		this.reportHold();
		this.playStartedAt = performance.now();
		this.playStartedTime = this.outputTime;
		this.lastRequestedFrame = -1;
		this.playClockAligned = false;
		this.audioClockAligned = false;
		this.audioOffsets = [];
		this.averageFrameCostMs = 0;
		this.lastRenderedAt = 0;
		this.slowFrames = 0;
		this.slowStreakMs = 0;
		this.fastFrames = 0;
		this.playbackBegan = performance.now();
		if (this.playbackScale !== 1 && this.previewBase) {
			this.previewScale = this.playbackScale;
			this.resizeForBase(this.previewBase.width, this.previewBase.height);
		}
		let firstTick = true;
		const tick = () => {
			if (!this.playing || this.disposed) return;
			this.animationFrame = requestAnimationFrame(tick);
			if (this.frameBusy) {
				perfCount("tick.busy");
				if (
					!this.stalled &&
					performance.now() - this.renderStartedAt > STALL_MS
				) {
					this.stalled = true;
					this.audio.pause();
					this.reportHold();
					perfCount("playback.stall");
					perfEvent("hold");
				}
				return;
			}
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
			this.renderStartedAt = started;
			void this.renderAt(time, true)
				.then((rendered) => {
					if (rendered === false) this.pause();
					else if (rendered === true) {
						this.awaitingPlayingFrame = false;
						if (this.stalled) this.resumeAfterStall(time);
						this.reportHold();
						this.samplePlaybackFrameCost(performance.now() - started);
					}
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

	/// Whether a frame the viewer is waiting for is still loading: playback
	/// starting or held, or a paused frame past SEEK_HOLD_MS.
	private reportHold() {
		reportPlaybackBuffering(
			!this.disposed &&
				(this.seekHoldShown ||
					(this.playing && (this.awaitingPlayingFrame || this.stalled))),
		);
	}

	private bufferAhead(time: number) {
		this.bufferController?.abort();
		if (this.playing || this.disposed) return;
		const controller = new AbortController();
		this.bufferController = controller;
		const { signal } = controller;
		void (async () => {
			await whenMediaReadsIdle(signal);
			if (signal.aborted || this.playing || this.disposed) return;
			const mapped = this.timeline.map_frame(time);
			// A transition reads two clips at once; its few seconds play from
			// what the frame already loaded.
			if (mapped.length !== 11 || mapped[0] === 2) return;
			const clip = mapped[2];
			const sourceTimes = this.times.source_times(clip, mapped[3]);
			if (sourceTimes.length !== 2) return;
			const seconds = BUFFER_AHEAD_SECONDS * this.speed(mapped[1]);
			await Promise.all(
				(["display", "camera"] as const).map((track, index) => {
					const sourceTime = sourceTimes[index];
					return Number.isFinite(sourceTime) && sourceTime >= 0
						? this.decodedPool.bufferAhead(
								clip,
								track,
								sourceTime,
								seconds,
								signal,
							)
						: undefined;
				}),
			);
		})().catch(() => undefined);
	}

	/// A browser decoding on a starved machine can take longer than a video
	/// element's timeouts allow; until the preview has a first frame, giving
	/// up would leave it blank, so a timed out first frame is tried again.
	private async firstFrameRetried<T>(render: () => Promise<T>) {
		for (let attempt = 1; ; attempt++) {
			try {
				return await render();
			} catch (cause) {
				if (
					attempt >= FIRST_FRAME_ATTEMPTS ||
					this.disposed ||
					this.canvas.hasRenderedFrame() ||
					!(cause instanceof Error) ||
					!cause.message.includes("timed out")
				) {
					throw cause;
				}
				perfEvent("frame.retry");
			}
		}
	}

	/// A paused frame still waiting on its media gives way to a newer request
	/// (the playhead after a hover, or the time Play starts from), which would
	/// otherwise wait behind it for as long as its media takes to load. Its
	/// reads carry on, so coming back to it later is quicker.
	private abandonHeldSeek() {
		if (
			this.seekHeld &&
			this.pendingSeek !== null &&
			this.pendingSeek !== this.drawingSeek
		) {
			perfEvent("seek.abandon");
			this.frameController?.abort();
		}
	}

	private holdForSeek(waiting: boolean) {
		clearTimeout(this.seekHoldTimer);
		if (waiting) {
			this.seekHoldTimer = setTimeout(() => {
				this.seekHeld = true;
				// Until the first frame the editor shows its own loading state,
				// and a second indicator's animation competes with that frame's
				// decode on a slow machine.
				this.seekHoldShown = this.canvas.hasRenderedFrame();
				this.reportHold();
				if (performance.now() - this.lastSeekRequestAt >= SEEK_SETTLE_MS)
					this.abandonHeldSeek();
			}, SEEK_HOLD_MS);
			return;
		}
		if (!this.seekHeld) return;
		this.seekHeld = false;
		this.seekHoldShown = false;
		this.reportHold();
	}

	private resumeAfterStall(time: number) {
		this.stalled = false;
		perfEvent("hold.release");
		if (!this.playing || this.disposed) return;
		this.playStartedAt = performance.now();
		this.playStartedTime = time;
		this.audioClockAligned = false;
		this.audioOffsets = [];
		this.lastRenderedAt = 0;
		this.audio.resume();
	}

	pause() {
		if (!this.playing) return;
		this.playing = false;
		this.stalled = false;
		this.awaitingPlayingFrame = false;
		this.reportHold();
		this.playController?.abort();
		this.playController = null;
		this.jumpCamera();
		cancelAnimationFrame(this.animationFrame);
		this.pool.pause();
		this.audio.pause();
		if (
			this.previewScale !== 1 ||
			performance.now() - this.playbackBegan >= PLAYBACK_SCALE_SETTLED_MS
		) {
			this.playbackScale = this.previewScale;
		}
		// Playback may have lowered the resolution to keep up; a paused frame
		// always renders at full detail.
		if (this.previewScale !== 1) {
			this.previewScale = 1;
			this.averageFrameCostMs = 0;
			this.lastRenderedAt = 0;
			this.slowFrames = 0;
			this.slowStreakMs = 0;
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
		reportPlaybackBuffering(false);
		this.disposed = true;
		clearTimeout(this.refineTimer);
		clearTimeout(this.seekHoldTimer);
		clearTimeout(this.seekSettleTimer);
		this.bufferController?.abort();
		this.frameController?.abort();
		this.heldCamera?.frame.close();
		this.heldCamera = null;
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
