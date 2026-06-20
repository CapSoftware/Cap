"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@cap/ui";
import type { Video } from "@cap/web-domain";
import {
	ChevronLeft,
	ChevronRight,
	Minus,
	Pause,
	Play,
	Plus,
	Redo2,
	RotateCcw,
	Scissors,
	Trash2,
	Undo2,
	X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
	Fragment,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	restoreVideoToOriginal,
	saveVideoEdits,
} from "@/actions/videos/save-edits";
import {
	clearTimelineDraft,
	getTimelineDraftKey,
	getTimelineDraftStorage,
	readTimelineDraft,
	writeTimelineDraft,
} from "@/lib/video-edit-drafts";
import {
	areEditSpecsEquivalent,
	areTimelineStatesEquivalent,
	createTimelineHistory,
	createTimelineState,
	deleteSelectedTimelineSegment,
	dragTimelineDisplaySplitPoint,
	findNextPlayableTime,
	getEditSpecOutputDuration,
	getTimelineDisplayDuration,
	getTimelineDisplaySegments,
	getTimelineDisplaySplitDragTargetTime,
	getTimelineDisplaySplitPoints,
	getTimelineEditSpec,
	getTimelineKeepRanges,
	getTimelineSegments,
	mapSourceTimeToOutputTime,
	mapTimelineDisplayTimeToSourceTime,
	mapTimelineSourceTimeToDisplayTime,
	pushTimelineHistory,
	redoTimelineHistory,
	removeTimelineDisplaySplitPoint,
	selectTimelineSegment,
	setTimelineTrim,
	splitTimelineAt,
	type TimelineHistory,
	undoTimelineHistory,
	type VideoTimelineDisplaySplitDragHandle,
	type VideoTimelineState,
} from "@/lib/video-edits";
import { navigateWithTransition } from "@/utils/view-transition";
import { CapVideoPlayer } from "../_components/CapVideoPlayer";
import { VideoDownloadMenu } from "../_components/VideoDownloadMenu";
import { captureVideoFrameDataUrl } from "../_components/video-frame-thumbnail";

type EditableVideo = {
	id: Video.VideoId;
	name: string;
	ownerId: string;
	duration: number;
	width: number | null;
	height: number | null;
};

type DragHandle = "start" | "end";

const MAX_TIMELINE_THUMBNAILS = 48;
const MAX_VISIBLE_THUMBNAIL_GENERATION = 16;
const TIMELINE_THUMBNAIL_WIDTH = 160;
const TIMELINE_THUMBNAIL_HEIGHT = 90;
const MIN_ZOOM = 1;
const MAX_ZOOM = 12;
const THUMBNAIL_FRAME_BATCH_SIZE = 4;

type TimelineThumbnailFrame = {
	src: string;
	time: number;
};

type TimelineThumbnailRequest = {
	key: string;
	time: number;
};

function formatTime(seconds: number) {
	const safeSeconds = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(safeSeconds / 60);
	const remainingSeconds = safeSeconds % 60;
	return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatTimeDetailed(seconds: number) {
	const safe = Math.max(0, seconds);
	const minutes = Math.floor(safe / 60);
	const remainingSeconds = safe - minutes * 60;
	const padded = remainingSeconds.toFixed(2).padStart(5, "0");
	return `${String(minutes).padStart(2, "0")}:${padded}`;
}

function getTimePercent(time: number, duration: number) {
	if (duration <= 0) return 0;
	return Math.min(100, Math.max(0, (time / duration) * 100));
}

function clampZoom(value: number) {
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function waitForNextFrame() {
	return new Promise<void>((resolve) => {
		requestAnimationFrame(() => resolve());
	});
}

function scheduleIdle(callback: () => void) {
	const idleWindow = window as Window & {
		requestIdleCallback?: (
			callback: () => void,
			options?: { timeout?: number },
		) => number;
		cancelIdleCallback?: (id: number) => void;
	};

	if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
		const id = idleWindow.requestIdleCallback(callback, { timeout: 500 });
		return () => idleWindow.cancelIdleCallback?.(id);
	}

	const id = window.setTimeout(callback, 120);
	return () => window.clearTimeout(id);
}

function getTimelineThumbnailTime(
	index: number,
	count: number,
	duration: number,
) {
	if (duration <= 0 || count <= 0) return 0;
	const slotProgress = (index + 0.5) / count;
	return Math.min(Math.max(slotProgress * duration, 0), duration);
}

function getTimelineThumbnailKey(time: number) {
	return `${Math.round(time * 10) / 10}`;
}

function getNearestTimelineFrame(
	frames: TimelineThumbnailFrame[],
	time: number,
) {
	let nearest: TimelineThumbnailFrame | null = null;
	let nearestDistance = Number.POSITIVE_INFINITY;

	for (const frame of frames) {
		const distance = Math.abs(frame.time - time);
		if (distance < nearestDistance) {
			nearest = frame;
			nearestDistance = distance;
		}
	}

	return nearest;
}

function waitForVideoMetadata(video: HTMLVideoElement) {
	if (video.readyState >= 1) return Promise.resolve(true);

	return new Promise<boolean>((resolve) => {
		let timeoutId = 0;
		const settle = (value: boolean) => {
			window.clearTimeout(timeoutId);
			video.removeEventListener("loadedmetadata", handleLoaded);
			video.removeEventListener("error", handleError);
			resolve(value);
		};
		const handleLoaded = () => settle(true);
		const handleError = () => settle(false);

		timeoutId = window.setTimeout(() => settle(false), 5000);
		video.addEventListener("loadedmetadata", handleLoaded);
		video.addEventListener("error", handleError);
	});
}

function seekVideoForThumbnail(video: HTMLVideoElement, time: number) {
	return new Promise<boolean>((resolve) => {
		let timeoutId = 0;
		let frameId = 0;
		const settle = (value: boolean) => {
			window.clearTimeout(timeoutId);
			cancelAnimationFrame(frameId);
			video.removeEventListener("seeked", handleSeeked);
			video.removeEventListener("loadeddata", handleLoadedData);
			video.removeEventListener("error", handleError);
			resolve(value);
		};
		const handleSeeked = () => settle(true);
		const handleLoadedData = () => {
			if (Math.abs(video.currentTime - time) <= 0.08) settle(true);
		};
		const handleError = () => settle(false);

		timeoutId = window.setTimeout(() => settle(false), 3500);
		video.addEventListener("seeked", handleSeeked);
		video.addEventListener("loadeddata", handleLoadedData);
		video.addEventListener("error", handleError);

		try {
			video.currentTime = time;
			if (video.readyState >= 2 && Math.abs(video.currentTime - time) <= 0.08) {
				frameId = requestAnimationFrame(() => settle(true));
			}
		} catch {
			settle(false);
		}
	});
}

function releaseThumbnailVideo(video: HTMLVideoElement | null) {
	if (!video) return;
	video.removeAttribute("src");
	video.load();
}

function getClampedVideoTime(
	time: number,
	video: HTMLVideoElement | null,
	fallbackDuration: number,
) {
	const upper =
		video && Number.isFinite(video.duration)
			? Math.min(video.duration, fallbackDuration)
			: fallbackDuration;
	return Math.min(Math.max(time, 0), upper);
}

function getTimelineSourceTimeFromClientX(
	clientX: number,
	rect: DOMRect,
	state: VideoTimelineState,
) {
	const displayDuration = getTimelineDisplayDuration(state);
	if (displayDuration <= 0 || rect.width <= 0) return 0;
	const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
	const displayTime = (x / rect.width) * displayDuration;
	return mapTimelineDisplayTimeToSourceTime(state, displayTime);
}

function HeaderIconButton({
	label,
	disabled,
	onClick,
	children,
}: {
	label: string;
	disabled?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className="inline-flex size-9 items-center justify-center rounded-full text-gray-12 transition hover:bg-gray-3 active:bg-gray-4 disabled:pointer-events-none disabled:opacity-30"
		>
			{children}
		</button>
	);
}

function ToolButton({
	active,
	disabled,
	onClick,
	icon,
	label,
	tone = "default",
}: {
	active?: boolean;
	disabled?: boolean;
	onClick: () => void;
	icon: React.ReactNode;
	label: string;
	tone?: "default" | "danger";
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className={[
				"inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition",
				active
					? "bg-pink-500 text-white shadow-[0_2px_8px_-2px_rgba(236,72,153,0.6)]"
					: tone === "danger"
						? "text-red-500 hover:bg-red-50 active:bg-red-100"
						: "text-gray-12 hover:bg-gray-3 active:bg-gray-4",
				"disabled:pointer-events-none disabled:opacity-30",
			].join(" ")}
		>
			{icon}
			<span>{label}</span>
		</button>
	);
}

function useThumbnailCount(ref: React.RefObject<HTMLDivElement | null>) {
	const [count, setCount] = useState(8);

	useEffect(() => {
		const node = ref.current;
		if (!node) return;

		const resizeObserver = new ResizeObserver(([entry]) => {
			const width = entry?.contentRect.width ?? 0;
			const nextCount = Math.min(
				MAX_TIMELINE_THUMBNAILS,
				Math.max(6, Math.floor(width / 96)),
			);
			setCount((current) => (current === nextCount ? current : nextCount));
		});

		resizeObserver.observe(node);
		return () => resizeObserver.disconnect();
	}, [ref]);

	return count;
}

function isThumbnailResponse(value: unknown): value is { screen: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"screen" in value &&
		typeof value.screen === "string"
	);
}

function useTimelineCoverThumbnail(videoId: Video.VideoId) {
	const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		setThumbnailUrl(null);
		const timeoutId = window.setTimeout(async () => {
			try {
				const response = await fetch(
					`/api/thumbnail?videoId=${encodeURIComponent(videoId)}`,
					{ signal: controller.signal },
				);
				if (!response.ok) return;
				const body: unknown = await response.json();
				if (!controller.signal.aborted && isThumbnailResponse(body)) {
					setThumbnailUrl(body.screen);
				}
			} catch (error) {
				if (error instanceof DOMException && error.name === "AbortError") {
					return;
				}
			}
		}, 0);

		return () => {
			window.clearTimeout(timeoutId);
			controller.abort();
		};
	}, [videoId]);

	return thumbnailUrl;
}

function useVisibleTimelineThumbnailRange({
	scrollContainerRef,
	timelineRef,
	thumbnailCount,
}: {
	scrollContainerRef: React.RefObject<HTMLDivElement | null>;
	timelineRef: React.RefObject<HTMLDivElement | null>;
	thumbnailCount: number;
}) {
	const [range, setRange] = useState(() => ({
		start: 0,
		end: Math.max(0, Math.min(thumbnailCount - 1, 7)),
	}));

	useEffect(() => {
		const container = scrollContainerRef.current;
		const timeline = timelineRef.current;
		if (!container || !timeline || thumbnailCount <= 0) {
			setRange({ start: 0, end: -1 });
			return;
		}

		let frameId = 0;
		const updateRange = () => {
			cancelAnimationFrame(frameId);
			frameId = requestAnimationFrame(() => {
				const timelineWidth =
					timeline.scrollWidth || timeline.getBoundingClientRect().width;
				const slotWidth = timelineWidth / thumbnailCount;
				if (slotWidth <= 0) {
					setRange({ start: 0, end: -1 });
					return;
				}

				const rawStart = Math.floor(container.scrollLeft / slotWidth) - 1;
				const rawEnd =
					Math.ceil(
						(container.scrollLeft + container.clientWidth) / slotWidth,
					) + 1;
				const start = Math.min(Math.max(rawStart, 0), thumbnailCount - 1);
				const end = Math.min(
					Math.max(rawEnd, start),
					start + MAX_VISIBLE_THUMBNAIL_GENERATION - 1,
					thumbnailCount - 1,
				);

				setRange((current) =>
					current.start === start && current.end === end
						? current
						: { start, end },
				);
			});
		};

		updateRange();
		container.addEventListener("scroll", updateRange, { passive: true });
		const resizeObserver = new ResizeObserver(updateRange);
		resizeObserver.observe(container);
		resizeObserver.observe(timeline);

		return () => {
			cancelAnimationFrame(frameId);
			container.removeEventListener("scroll", updateRange);
			resizeObserver.disconnect();
		};
	}, [scrollContainerRef, thumbnailCount, timelineRef]);

	return range;
}

function useLazyTimelineThumbnails({
	videoSrc,
	sourceDuration,
	thumbnailTimes,
	visibleRange,
	enabled,
}: {
	videoSrc: string;
	sourceDuration: number;
	thumbnailTimes: TimelineThumbnailRequest[];
	visibleRange: { start: number; end: number };
	enabled: boolean;
}) {
	const [frames, setFrames] = useState<Record<string, TimelineThumbnailFrame>>(
		{},
	);
	const processedRef = useRef<Set<string>>(new Set());
	const resetKey = `${videoSrc}:${sourceDuration}`;
	const resetKeyRef = useRef(resetKey);

	useEffect(() => {
		if (resetKeyRef.current === resetKey) return;
		resetKeyRef.current = resetKey;
		processedRef.current = new Set();
		setFrames({});
	}, [resetKey]);

	useEffect(() => {
		if (
			!enabled ||
			!videoSrc ||
			sourceDuration <= 0 ||
			thumbnailTimes.length <= 0 ||
			visibleRange.end < visibleRange.start
		) {
			return;
		}

		const pendingByKey = new Map<string, { time: number }>();
		for (let index = visibleRange.start; index <= visibleRange.end; index++) {
			const thumbnailTime = thumbnailTimes[index];
			if (!thumbnailTime) continue;
			const { key, time } = thumbnailTime;
			if (!processedRef.current.has(key)) {
				pendingByKey.set(key, { time });
			}
		}
		const pending = Array.from(pendingByKey, ([key, value]) => ({
			key,
			time: value.time,
		}));
		if (pending.length === 0) return;

		let cancelled = false;
		let video: HTMLVideoElement | null = null;

		const cancelIdle = scheduleIdle(() => {
			void (async () => {
				video = document.createElement("video");
				video.crossOrigin = "anonymous";
				video.muted = true;
				video.playsInline = true;
				video.preload = "metadata";
				video.src = videoSrc;
				video.load();

				const hasMetadata = await waitForVideoMetadata(video);
				if (cancelled || !hasMetadata) {
					releaseThumbnailVideo(video);
					video = null;
					return;
				}

				const safeSourceDuration = Number.isFinite(video.duration)
					? Math.min(video.duration, sourceDuration)
					: sourceDuration;
				let frameBatch: Record<string, TimelineThumbnailFrame> = {};
				let frameBatchSize = 0;
				const flushFrameBatch = () => {
					if (frameBatchSize === 0) return;
					const nextBatch = frameBatch;
					frameBatch = {};
					frameBatchSize = 0;
					setFrames((current) => {
						let changed = false;
						const nextFrames = { ...current };
						for (const [key, frame] of Object.entries(nextBatch)) {
							if (nextFrames[key]?.src === frame.src) continue;
							nextFrames[key] = frame;
							changed = true;
						}
						return changed ? nextFrames : current;
					});
				};

				for (const item of pending) {
					if (cancelled) break;
					const time = Math.min(item.time, safeSourceDuration);
					const seeked = await seekVideoForThumbnail(video, time);
					if (cancelled) break;

					processedRef.current.add(item.key);
					if (seeked) {
						const frame = captureVideoFrameDataUrl({
							video,
							width: TIMELINE_THUMBNAIL_WIDTH,
							height: TIMELINE_THUMBNAIL_HEIGHT,
							quality: 0.55,
						});
						if (frame) {
							frameBatch[item.key] = { src: frame, time };
							frameBatchSize += 1;
							if (frameBatchSize >= THUMBNAIL_FRAME_BATCH_SIZE) {
								flushFrameBatch();
							}
						}
					}

					await waitForNextFrame();
				}

				if (!cancelled) {
					flushFrameBatch();
				}

				releaseThumbnailVideo(video);
				video = null;
			})();
		});

		return () => {
			cancelled = true;
			cancelIdle();
			releaseThumbnailVideo(video);
			video = null;
		};
	}, [
		enabled,
		sourceDuration,
		thumbnailTimes,
		videoSrc,
		visibleRange.end,
		visibleRange.start,
	]);

	return frames;
}

export function EditVideoClient({
	video,
	hasExistingEdits,
}: {
	video: EditableVideo;
	hasExistingEdits: boolean;
}) {
	const router = useRouter();
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const timelineRef = useRef<HTMLDivElement | null>(null);
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);
	const playheadOverlayRef = useRef<HTMLDivElement | null>(null);
	const stateRef = useRef<VideoTimelineState>(
		createTimelineState(video.duration),
	);
	const dragDraftRef = useRef<VideoTimelineState | null>(null);
	const pendingPlayheadRef = useRef<number | null>(null);
	const playheadFrameRef = useRef(0);
	const pendingVideoSeekRef = useRef<number | null>(null);
	const videoSeekFrameRef = useRef(0);
	const zoomRef = useRef(1);
	const thumbnailCount = useThumbnailCount(timelineRef);
	const draftStorageKey = useMemo(
		() => getTimelineDraftKey(video.id),
		[video.id],
	);
	const initialState = useMemo(
		() => createTimelineState(video.duration),
		[video.duration],
	);
	const [history, setHistory] = useState<TimelineHistory>(() =>
		createTimelineHistory(initialState),
	);
	const [hydratedDraftKey, setHydratedDraftKey] = useState<string | null>(null);
	const [draftState, setDraftState] = useState<VideoTimelineState | null>(null);
	const [activeHandle, setActiveHandle] = useState<DragHandle | null>(null);
	const [splitToggle, setSplitToggle] = useState(false);
	const [splitKeyHeld, setSplitKeyHeld] = useState(false);
	const [splitButtonHeld, setSplitButtonHeld] = useState(false);
	const splitHoldStartRef = useRef<number | null>(null);
	const splitClickedDuringHoldRef = useRef(false);
	const splitMode = splitToggle || splitKeyHeld || splitButtonHeld;
	const [playhead, setPlayhead] = useState(0);
	const [isPlaying, setIsPlaying] = useState(false);
	const [zoom, setZoom] = useState(1);
	const [isSaving, setIsSaving] = useState(false);
	const [isRestoring, setIsRestoring] = useState(false);
	const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
	const [selectedSplitIndex, setSelectedSplitIndex] = useState<number | null>(
		null,
	);
	const committedState = history.entries[history.index] ?? initialState;
	const state = draftState ?? committedState;
	const editSpec = useMemo(() => getTimelineEditSpec(state), [state]);
	const initialEditSpec = useMemo(
		() => getTimelineEditSpec(initialState),
		[initialState],
	);
	const hasTimelineChanges = useMemo(
		() => !areEditSpecsEquivalent(initialEditSpec, editSpec),
		[editSpec, initialEditSpec],
	);
	const hasDraftChanges = useMemo(
		() => !areTimelineStatesEquivalent(initialState, committedState),
		[committedState, initialState],
	);
	const keepRanges = useMemo(() => getTimelineKeepRanges(state), [state]);
	const segments = useMemo(() => getTimelineSegments(state), [state]);
	const visibleSegments = useMemo(
		() => segments.filter((segment) => !segment.deleted),
		[segments],
	);
	const timelineDisplayDuration = useMemo(
		() => getTimelineDisplayDuration(state),
		[state],
	);
	const timelineDisplaySegments = useMemo(
		() => getTimelineDisplaySegments(state),
		[state],
	);
	const timelineDisplaySplitPoints = useMemo(
		() => getTimelineDisplaySplitPoints(state),
		[state],
	);
	const playbackSrc = `/api/playlist?userId=${video.ownerId}&videoId=${video.id}&videoType=mp4`;
	const timelineThumbnailUrl = useTimelineCoverThumbnail(video.id);
	const visibleThumbnailRange = useVisibleTimelineThumbnailRange({
		scrollContainerRef,
		timelineRef,
		thumbnailCount,
	});
	const thumbnailTimes = useMemo(
		() =>
			Array.from({ length: thumbnailCount }, (_, index) => {
				const displayTime = getTimelineThumbnailTime(
					index,
					thumbnailCount,
					timelineDisplayDuration,
				);
				const time = mapTimelineDisplayTimeToSourceTime(state, displayTime);
				return {
					key: getTimelineThumbnailKey(time),
					time,
				};
			}),
		[thumbnailCount, state, timelineDisplayDuration],
	);
	const timelineFrames = useLazyTimelineThumbnails({
		videoSrc: playbackSrc,
		sourceDuration: video.duration,
		thumbnailTimes,
		visibleRange: visibleThumbnailRange,
		enabled: !isPlaying && activeHandle === null && draftState === null,
	});
	const timelineFrameList = useMemo(
		() => Object.values(timelineFrames),
		[timelineFrames],
	);
	const thumbnailSlots = useMemo(
		() =>
			thumbnailTimes.map(({ key, time }, index) => {
				const exactFrame = timelineFrames[key];
				const frame =
					exactFrame ?? getNearestTimelineFrame(timelineFrameList, time);
				return {
					key: `thumb-${index}`,
					src: frame?.src ?? timelineThumbnailUrl,
				};
			}),
		[thumbnailTimes, timelineFrameList, timelineFrames, timelineThumbnailUrl],
	);
	const canUndo = history.index > 0;
	const canRedo = history.index < history.entries.length - 1;
	const visibleSegmentCount = timelineDisplaySegments.length;
	const trimStartDisplayTime = mapTimelineSourceTimeToDisplayTime(
		state,
		state.trimStart,
	);
	const trimEndDisplayTime = mapTimelineSourceTimeToDisplayTime(
		state,
		state.trimEnd,
	);
	const trimStartPct = getTimePercent(
		trimStartDisplayTime,
		timelineDisplayDuration,
	);
	const trimEndPct = getTimePercent(
		trimEndDisplayTime,
		timelineDisplayDuration,
	);
	const trimWidthPct = Math.max(0, trimEndPct - trimStartPct);
	const clampedPlayhead = Math.min(
		Math.max(playhead, state.trimStart),
		state.trimEnd,
	);
	const displayPlayhead = mapTimelineSourceTimeToDisplayTime(
		state,
		clampedPlayhead,
	);
	const isTrimming = activeHandle !== null;
	const outputDuration = useMemo(
		() => getEditSpecOutputDuration(editSpec),
		[editSpec],
	);
	const outputPlayhead = useMemo(() => {
		const mapped = mapSourceTimeToOutputTime(clampedPlayhead, editSpec);
		if (mapped !== null) return mapped;
		let cumulative = 0;
		for (const range of editSpec.keepRanges) {
			if (clampedPlayhead < range.start) return cumulative;
			if (clampedPlayhead <= range.end) {
				return cumulative + (clampedPlayhead - range.start);
			}
			cumulative += range.end - range.start;
		}
		return cumulative;
	}, [clampedPlayhead, editSpec]);

	useEffect(() => {
		stateRef.current = state;
	}, [state]);

	useEffect(() => {
		zoomRef.current = zoom;
	}, [zoom]);

	useEffect(() => {
		const draftStorage = getTimelineDraftStorage();
		const restoredState = draftStorage
			? readTimelineDraft(draftStorage, draftStorageKey, video.duration)
			: null;
		const nextState = restoredState ?? initialState;
		setDraftState(null);
		dragDraftRef.current = null;
		setHistory(createTimelineHistory(nextState));
		setSelectedSplitIndex(null);
		setPlayhead(nextState.trimStart);
		setHydratedDraftKey(draftStorageKey);
	}, [draftStorageKey, initialState, video.duration]);

	useEffect(() => {
		if (hydratedDraftKey !== draftStorageKey) return;
		const draftStorage = getTimelineDraftStorage();
		if (!draftStorage) return;
		if (hasDraftChanges) {
			writeTimelineDraft(
				draftStorage,
				draftStorageKey,
				video.duration,
				committedState,
			);
			return;
		}
		clearTimelineDraft(draftStorage, draftStorageKey);
	}, [
		committedState,
		draftStorageKey,
		hasDraftChanges,
		hydratedDraftKey,
		video.duration,
	]);

	useEffect(() => {
		setSelectedSplitIndex((current) => {
			if (current === null) return current;
			return current >= timelineDisplaySplitPoints.length ? null : current;
		});
	}, [timelineDisplaySplitPoints.length]);

	const setPlayheadOnFrame = useCallback((time: number, immediate = false) => {
		if (immediate) {
			if (playheadFrameRef.current !== 0) {
				cancelAnimationFrame(playheadFrameRef.current);
				playheadFrameRef.current = 0;
			}
			pendingPlayheadRef.current = null;
			setPlayhead(time);
			return;
		}

		pendingPlayheadRef.current = time;
		if (playheadFrameRef.current !== 0) return;

		playheadFrameRef.current = requestAnimationFrame(() => {
			playheadFrameRef.current = 0;
			const nextTime = pendingPlayheadRef.current;
			pendingPlayheadRef.current = null;
			if (nextTime !== null) setPlayhead(nextTime);
		});
	}, []);

	const setVideoTimeOnFrame = useCallback((time: number, immediate = false) => {
		const applySeek = () => {
			const videoElement = videoRef.current;
			const nextTime = pendingVideoSeekRef.current;
			pendingVideoSeekRef.current = null;
			if (!videoElement || nextTime === null) return;
			if (Math.abs(videoElement.currentTime - nextTime) > 0.01) {
				videoElement.currentTime = nextTime;
			}
		};

		pendingVideoSeekRef.current = time;

		if (immediate) {
			if (videoSeekFrameRef.current !== 0) {
				cancelAnimationFrame(videoSeekFrameRef.current);
				videoSeekFrameRef.current = 0;
			}
			applySeek();
			return;
		}

		if (videoSeekFrameRef.current !== 0) return;

		videoSeekFrameRef.current = requestAnimationFrame(() => {
			videoSeekFrameRef.current = 0;
			applySeek();
		});
	}, []);

	useEffect(
		() => () => {
			if (playheadFrameRef.current !== 0) {
				cancelAnimationFrame(playheadFrameRef.current);
			}
			if (videoSeekFrameRef.current !== 0) {
				cancelAnimationFrame(videoSeekFrameRef.current);
			}
		},
		[],
	);

	const updatePlayheadOverlay = useCallback(() => {
		const container = scrollContainerRef.current;
		const overlay = playheadOverlayRef.current;
		if (!container || !overlay) return;
		const fraction =
			timelineDisplayDuration > 0
				? displayPlayhead / timelineDisplayDuration
				: 0;
		const x = fraction * container.scrollWidth - container.scrollLeft;
		overlay.style.transform = `translate3d(${x}px, 0, 0) translateX(-50%)`;
	}, [displayPlayhead, timelineDisplayDuration]);

	const commitState = useCallback((nextState: VideoTimelineState) => {
		setDraftState(null);
		dragDraftRef.current = null;
		setHistory((currentHistory) =>
			pushTimelineHistory(currentHistory, nextState),
		);
	}, []);

	const handleUndo = useCallback(() => {
		setDraftState(null);
		setHistory(undoTimelineHistory);
	}, []);

	const handleRedo = useCallback(() => {
		setDraftState(null);
		setHistory(redoTimelineHistory);
	}, []);

	const handleSplitButtonPointerDown = useCallback(() => {
		splitHoldStartRef.current = Date.now();
		splitClickedDuringHoldRef.current = false;
		setSplitButtonHeld(true);
	}, []);

	const handleSplitButtonPointerUp = useCallback(() => {
		const heldFor = Date.now() - (splitHoldStartRef.current ?? Date.now());
		const clickedDuringHold = splitClickedDuringHoldRef.current;
		splitHoldStartRef.current = null;
		splitClickedDuringHoldRef.current = false;
		setSplitButtonHeld(false);
		if (heldFor < 250 && !clickedDuringHold) {
			setSplitToggle((prev) => !prev);
		}
	}, []);

	useEffect(() => {
		if (!splitButtonHeld) return;
		const handleUp = () => {
			const heldFor = Date.now() - (splitHoldStartRef.current ?? Date.now());
			const clickedDuringHold = splitClickedDuringHoldRef.current;
			splitHoldStartRef.current = null;
			splitClickedDuringHoldRef.current = false;
			setSplitButtonHeld(false);
			if (heldFor < 250 && !clickedDuringHold) {
				setSplitToggle((prev) => !prev);
			}
		};
		document.addEventListener("pointerup", handleUp);
		document.addEventListener("pointercancel", handleUp);
		return () => {
			document.removeEventListener("pointerup", handleUp);
			document.removeEventListener("pointercancel", handleUp);
		};
	}, [splitButtonHeld]);

	const removeSplitAtIndex = useCallback(
		(index: number) => {
			commitState(removeTimelineDisplaySplitPoint(stateRef.current, index));
			setSelectedSplitIndex(null);
		},
		[commitState],
	);

	const activeSegmentAtPlayhead = useMemo(
		() =>
			visibleSegments.find(
				(segment) =>
					playhead >= segment.start - 0.001 && playhead <= segment.end + 0.001,
			),
		[playhead, visibleSegments],
	);
	const canDeleteSegment =
		activeSegmentAtPlayhead !== undefined && visibleSegmentCount > 1;

	const handleDelete = useCallback(() => {
		if (!activeSegmentAtPlayhead) return;
		if (visibleSegments.length <= 1) return;
		const withSelection = selectTimelineSegment(
			stateRef.current,
			activeSegmentAtPlayhead.id,
		);
		commitState(deleteSelectedTimelineSegment(withSelection));
	}, [activeSegmentAtPlayhead, commitState, visibleSegments.length]);

	const handleBackspace = useCallback(() => {
		if (selectedSplitIndex !== null) {
			commitState(
				removeTimelineDisplaySplitPoint(stateRef.current, selectedSplitIndex),
			);
			setSelectedSplitIndex(null);
			return;
		}
		const SPLIT_SNAP = 0.25;
		const splitAtPlayheadIndex = timelineDisplaySplitPoints.findIndex(
			(splitPoint) =>
				splitPoint.sourceTimes.some(
					(sourceTime) => Math.abs(sourceTime - playhead) <= SPLIT_SNAP,
				),
		);
		if (splitAtPlayheadIndex !== -1) {
			commitState(
				removeTimelineDisplaySplitPoint(stateRef.current, splitAtPlayheadIndex),
			);
			return;
		}
		handleDelete();
	}, [
		commitState,
		handleDelete,
		playhead,
		selectedSplitIndex,
		timelineDisplaySplitPoints,
	]);

	const handleDone = useCallback(async () => {
		if (isSaving) return;
		const draftStorage = getTimelineDraftStorage();
		if (!hasTimelineChanges) {
			if (draftStorage) clearTimelineDraft(draftStorage, draftStorageKey);
			router.push(`/s/${video.id}`);
			return;
		}
		setIsSaving(true);
		try {
			await saveVideoEdits(video.id, editSpec);
			if (draftStorage) clearTimelineDraft(draftStorage, draftStorageKey);
			router.push(`/s/${video.id}`);
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to start video edit",
			);
			setIsSaving(false);
		}
	}, [
		draftStorageKey,
		editSpec,
		hasTimelineChanges,
		isSaving,
		router,
		video.id,
	]);

	const handleCancel = useCallback(() => {
		const draftStorage = getTimelineDraftStorage();
		if (draftStorage) clearTimelineDraft(draftStorage, draftStorageKey);
		navigateWithTransition("edit-exit", () => router.push(`/s/${video.id}`));
	}, [draftStorageKey, router, video.id]);

	const resetTimeline = useCallback(() => {
		const draftStorage = getTimelineDraftStorage();
		setDraftState(null);
		dragDraftRef.current = null;
		setHistory(createTimelineHistory(initialState));
		setSelectedSplitIndex(null);
		setPlayhead(initialState.trimStart);
		if (draftStorage) clearTimelineDraft(draftStorage, draftStorageKey);
	}, [draftStorageKey, initialState]);

	const canRestore = hasExistingEdits || hasTimelineChanges;

	const handleRestore = useCallback(async () => {
		if (isRestoring || isSaving) return;

		if (!hasExistingEdits) {
			resetTimeline();
			setShowRestoreConfirm(false);
			return;
		}

		setIsRestoring(true);
		try {
			await restoreVideoToOriginal(video.id);
			resetTimeline();
			setShowRestoreConfirm(false);
			router.push(`/s/${video.id}`);
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to restore video",
			);
			setIsRestoring(false);
		}
	}, [
		hasExistingEdits,
		isRestoring,
		isSaving,
		resetTimeline,
		router,
		video.id,
	]);

	const seekTo = useCallback(
		(time: number, immediate = false) => {
			const { trimStart, trimEnd } = stateRef.current;
			const trimmedTime = Math.min(Math.max(time, trimStart), trimEnd);
			const clamped = getClampedVideoTime(
				trimmedTime,
				videoRef.current,
				trimEnd,
			);
			setVideoTimeOnFrame(Math.max(clamped, trimStart), immediate);
			setPlayheadOnFrame(Math.max(clamped, trimStart), immediate);
		},
		[setPlayheadOnFrame, setVideoTimeOnFrame],
	);

	const togglePlayPause = useCallback(() => {
		const videoElement = videoRef.current;
		if (!videoElement) return;
		if (videoElement.paused) {
			void videoElement.play();
		} else {
			videoElement.pause();
		}
	}, []);

	const startSplitDrag = useCallback(
		(
			splitIndex: number,
			splitTime: number,
			handle: VideoTimelineDisplaySplitDragHandle,
			event: React.PointerEvent<HTMLButtonElement>,
		) => {
			event.preventDefault();
			event.stopPropagation();
			const timeline = timelineRef.current;
			if (!timeline) return;

			const baseState = stateRef.current;
			const sortedSplits = [...baseState.splitPoints].sort((a, b) => a - b);
			const sourceSplitIndex = sortedSplits.findIndex(
				(value) => Math.abs(value - splitTime) < 0.001,
			);
			if (sourceSplitIndex === -1) return;

			const rect = timeline.getBoundingClientRect();
			let dragged = false;
			let lastPreviewTime = splitTime;
			let draftFrameId = 0;
			let pendingClientX = event.clientX;
			const computeTime = (clientX: number) =>
				getTimelineSourceTimeFromClientX(clientX, rect, baseState);
			const updateDraft = (clientX: number) => {
				const time =
					getTimelineDisplaySplitDragTargetTime(
						baseState,
						splitIndex,
						handle,
						computeTime(clientX),
					) ?? splitTime;
				const nextState = dragTimelineDisplaySplitPoint(
					baseState,
					splitIndex,
					handle,
					time,
				);
				dragDraftRef.current = nextState;
				setDraftState(nextState);
				const clamped = getClampedVideoTime(
					time,
					videoRef.current,
					baseState.duration,
				);
				lastPreviewTime = clamped;
				setVideoTimeOnFrame(clamped);
				setPlayheadOnFrame(clamped);
			};
			const scheduleDraftUpdate = (clientX: number) => {
				pendingClientX = clientX;
				if (draftFrameId !== 0) return;
				draftFrameId = requestAnimationFrame(() => {
					draftFrameId = 0;
					updateDraft(pendingClientX);
				});
			};
			const handlePointerMove = (moveEvent: PointerEvent) => {
				dragged = true;
				scheduleDraftUpdate(moveEvent.clientX);
			};
			const handlePointerUp = (upEvent: PointerEvent) => {
				window.removeEventListener("pointermove", handlePointerMove);
				window.removeEventListener("pointerup", handlePointerUp);
				if (draftFrameId !== 0) {
					cancelAnimationFrame(draftFrameId);
					draftFrameId = 0;
				}
				if (dragged) {
					updateDraft(upEvent.clientX);
				}
				if (dragged && dragDraftRef.current) {
					setVideoTimeOnFrame(lastPreviewTime, true);
					setPlayheadOnFrame(lastPreviewTime, true);
					commitState(dragDraftRef.current);
					setSelectedSplitIndex(null);
				} else {
					setDraftState(null);
					dragDraftRef.current = null;
					seekTo(splitTime, true);
					setSelectedSplitIndex((current) =>
						current === splitIndex ? null : splitIndex,
					);
				}
			};

			window.addEventListener("pointermove", handlePointerMove);
			window.addEventListener("pointerup", handlePointerUp, { once: true });
		},
		[commitState, seekTo, setPlayheadOnFrame, setVideoTimeOnFrame],
	);

	const updateZoomAround = useCallback(
		(nextZoom: number, anchorClientX?: number) => {
			const container = scrollContainerRef.current;
			const clamped = clampZoom(nextZoom);
			if (!container) {
				setZoom(clamped);
				return;
			}
			const rect = container.getBoundingClientRect();
			const anchor =
				anchorClientX !== undefined
					? Math.min(Math.max(anchorClientX - rect.left, 0), rect.width)
					: rect.width / 2;
			const fraction =
				container.scrollWidth > 0
					? (container.scrollLeft + anchor) / container.scrollWidth
					: 0;

			setZoom(clamped);

			requestAnimationFrame(() => {
				const node = scrollContainerRef.current;
				if (!node) return;
				const newScrollWidth = node.scrollWidth;
				const newPosition = fraction * newScrollWidth;
				node.scrollLeft = newPosition - anchor;
			});
		},
		[],
	);

	const handleTimelinePointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (event.button !== 0) return;
			const target = event.target as HTMLElement;
			if (target.closest("[data-trim-handle]")) return;

			const timeline = timelineRef.current;
			if (!timeline) return;
			const rect = timeline.getBoundingClientRect();
			if (rect.width <= 0) return;

			const computeTime = (clientX: number) =>
				getTimelineSourceTimeFromClientX(clientX, rect, stateRef.current);

			const time = computeTime(event.clientX);
			setSelectedSplitIndex(null);

			if (splitMode) {
				commitState(splitTimelineAt(stateRef.current, time));
				setSplitToggle(false);
				splitClickedDuringHoldRef.current = true;
				seekTo(time, true);
				return;
			}

			seekTo(time, true);
			let lastTime = time;

			const handleMove = (moveEvent: PointerEvent) => {
				lastTime = computeTime(moveEvent.clientX);
				seekTo(lastTime);
			};
			const handleUp = (upEvent: PointerEvent) => {
				window.removeEventListener("pointermove", handleMove);
				window.removeEventListener("pointerup", handleUp);
				lastTime = computeTime(upEvent.clientX);
				seekTo(lastTime, true);
			};
			window.addEventListener("pointermove", handleMove);
			window.addEventListener("pointerup", handleUp, { once: true });
		},
		[commitState, seekTo, splitMode],
	);

	const startHandleDrag = useCallback(
		(handle: DragHandle, event: React.PointerEvent<HTMLButtonElement>) => {
			event.preventDefault();
			event.stopPropagation();
			const timeline = timelineRef.current;
			if (!timeline) return;

			setActiveHandle(handle);
			const baseState = stateRef.current;
			const rect = timeline.getBoundingClientRect();
			let lastPreviewTime =
				handle === "start" ? baseState.trimStart : baseState.trimEnd;
			let draftFrameId = 0;
			let pendingClientX = event.clientX;
			const getTimeFromClientX = (clientX: number) =>
				getTimelineSourceTimeFromClientX(clientX, rect, baseState);
			const updateDraft = (clientX: number) => {
				const time = getTimeFromClientX(clientX);
				const nextState =
					handle === "start"
						? setTimelineTrim(baseState, time, baseState.trimEnd)
						: setTimelineTrim(baseState, baseState.trimStart, time);
				dragDraftRef.current = nextState;
				setDraftState(nextState);
				const clamped = getClampedVideoTime(
					time,
					videoRef.current,
					baseState.duration,
				);
				lastPreviewTime = clamped;
				setVideoTimeOnFrame(clamped);
				setPlayheadOnFrame(clamped);
			};
			const scheduleDraftUpdate = (clientX: number) => {
				pendingClientX = clientX;
				if (draftFrameId !== 0) return;
				draftFrameId = requestAnimationFrame(() => {
					draftFrameId = 0;
					updateDraft(pendingClientX);
				});
			};
			const handlePointerMove = (moveEvent: PointerEvent) => {
				scheduleDraftUpdate(moveEvent.clientX);
			};
			const handlePointerUp = (upEvent: PointerEvent) => {
				window.removeEventListener("pointermove", handlePointerMove);
				window.removeEventListener("pointerup", handlePointerUp);
				if (draftFrameId !== 0) {
					cancelAnimationFrame(draftFrameId);
					draftFrameId = 0;
				}
				updateDraft(upEvent.clientX);
				setVideoTimeOnFrame(lastPreviewTime, true);
				setPlayheadOnFrame(lastPreviewTime, true);
				setActiveHandle(null);
				const nextState = dragDraftRef.current;
				if (nextState) {
					commitState(nextState);
				}
			};

			updateDraft(event.clientX);
			window.addEventListener("pointermove", handlePointerMove);
			window.addEventListener("pointerup", handlePointerUp, { once: true });
		},
		[commitState, setPlayheadOnFrame, setVideoTimeOnFrame],
	);

	useEffect(() => {
		let frameId = 0;
		let detachVideoListeners: (() => void) | null = null;

		const attachVideoListeners = () => {
			const videoElement = videoRef.current;
			if (!videoElement) {
				frameId = requestAnimationFrame(attachVideoListeners);
				return;
			}

			const syncPlayhead = () => {
				if (dragDraftRef.current !== null) {
					setPlayheadOnFrame(videoElement.currentTime, true);
					return;
				}
				const nextTime = findNextPlayableTime(
					videoElement.currentTime,
					editSpec,
				);

				if (nextTime === null) {
					videoElement.pause();
					videoElement.currentTime = keepRanges[0]?.start ?? 0;
					setPlayheadOnFrame(videoElement.currentTime, true);
					return;
				}

				if (Math.abs(nextTime - videoElement.currentTime) > 0.04) {
					videoElement.currentTime = nextTime;
					setPlayheadOnFrame(nextTime, true);
					return;
				}

				setPlayheadOnFrame(videoElement.currentTime, true);
			};

			const handlePlay = () => setIsPlaying(true);
			const handlePause = () => setIsPlaying(false);

			videoElement.addEventListener("timeupdate", syncPlayhead);
			videoElement.addEventListener("seeking", syncPlayhead);
			videoElement.addEventListener("loadedmetadata", syncPlayhead);
			videoElement.addEventListener("play", handlePlay);
			videoElement.addEventListener("pause", handlePause);
			setIsPlaying(!videoElement.paused);
			syncPlayhead();

			detachVideoListeners = () => {
				videoElement.removeEventListener("timeupdate", syncPlayhead);
				videoElement.removeEventListener("seeking", syncPlayhead);
				videoElement.removeEventListener("loadedmetadata", syncPlayhead);
				videoElement.removeEventListener("play", handlePlay);
				videoElement.removeEventListener("pause", handlePause);
			};
		};

		attachVideoListeners();

		return () => {
			cancelAnimationFrame(frameId);
			detachVideoListeners?.();
		};
	}, [editSpec, keepRanges, setPlayheadOnFrame]);

	useEffect(() => {
		const videoElement = videoRef.current;
		if (!videoElement) return;
		const nextTime = findNextPlayableTime(videoElement.currentTime, editSpec);
		if (
			nextTime !== null &&
			Math.abs(nextTime - videoElement.currentTime) > 0.04
		) {
			videoElement.currentTime = nextTime;
		}
	}, [editSpec]);

	useEffect(() => {
		const container = scrollContainerRef.current;
		if (!container || zoom <= 1 || isTrimming) return;
		const playheadFraction =
			timelineDisplayDuration > 0
				? displayPlayhead / timelineDisplayDuration
				: 0;
		const playheadX = playheadFraction * container.scrollWidth;
		const visibleStart = container.scrollLeft;
		const visibleEnd = visibleStart + container.clientWidth;
		const padding = 32;
		if (
			playheadX < visibleStart + padding ||
			playheadX > visibleEnd - padding
		) {
			container.scrollTo({
				left: Math.max(0, playheadX - container.clientWidth / 2),
				behavior: isPlaying ? "auto" : "smooth",
			});
		}
	}, [displayPlayhead, zoom, isPlaying, isTrimming, timelineDisplayDuration]);

	useEffect(() => {
		const container = scrollContainerRef.current;
		if (!container) return;
		const handleWheel = (event: WheelEvent) => {
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			const direction = event.deltaY > 0 ? -1 : 1;
			const factor =
				1 + direction * Math.min(Math.abs(event.deltaY) / 120, 1) * 0.25;
			updateZoomAround(zoomRef.current * factor, event.clientX);
		};
		container.addEventListener("wheel", handleWheel, { passive: false });
		return () => container.removeEventListener("wheel", handleWheel);
	}, [updateZoomAround]);

	useEffect(() => {
		updatePlayheadOverlay();
		const container = scrollContainerRef.current;
		if (!container) return;
		let frameId = 0;
		const onScroll = () => {
			cancelAnimationFrame(frameId);
			frameId = requestAnimationFrame(updatePlayheadOverlay);
		};
		container.addEventListener("scroll", onScroll, { passive: true });
		const resizeObserver = new ResizeObserver(onScroll);
		resizeObserver.observe(container);
		return () => {
			cancelAnimationFrame(frameId);
			container.removeEventListener("scroll", onScroll);
			resizeObserver.disconnect();
		};
	}, [updatePlayheadOverlay]);

	useEffect(() => {
		const isFormTarget = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			return (
				target?.tagName === "INPUT" ||
				target?.tagName === "TEXTAREA" ||
				target?.isContentEditable === true
			);
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (isFormTarget(event)) return;
			const isMeta = event.metaKey || event.ctrlKey;

			if (
				event.key === "Escape" &&
				(splitToggle || splitKeyHeld || splitButtonHeld)
			) {
				event.preventDefault();
				setSplitToggle(false);
				setSplitKeyHeld(false);
				setSplitButtonHeld(false);
				splitHoldStartRef.current = null;
				splitClickedDuringHoldRef.current = false;
				return;
			}

			if (event.key === " ") {
				event.preventDefault();
				togglePlayPause();
				return;
			}

			if (event.key === "Backspace" || event.key === "Delete") {
				event.preventDefault();
				handleBackspace();
				return;
			}

			if (event.key.toLowerCase() === "s" && !isMeta) {
				event.preventDefault();
				if (!event.repeat) setSplitKeyHeld(true);
				return;
			}

			if (event.key === "ArrowLeft") {
				event.preventDefault();
				const step = event.shiftKey ? 1 : 0.1;
				seekTo(playhead - step, true);
				return;
			}

			if (event.key === "ArrowRight") {
				event.preventDefault();
				const step = event.shiftKey ? 1 : 0.1;
				seekTo(playhead + step, true);
				return;
			}

			if (isMeta && event.key.toLowerCase() === "z") {
				event.preventDefault();
				if (event.shiftKey) {
					handleRedo();
				} else {
					handleUndo();
				}
				return;
			}

			if (event.key === "+" || event.key === "=") {
				event.preventDefault();
				updateZoomAround(zoomRef.current * 1.25);
				return;
			}

			if (event.key === "-" || event.key === "_") {
				event.preventDefault();
				updateZoomAround(zoomRef.current / 1.25);
				return;
			}

			if (event.key === "0") {
				event.preventDefault();
				updateZoomAround(1);
				return;
			}
		};

		const handleKeyUp = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() === "s") {
				setSplitKeyHeld(false);
			}
		};

		const handleBlur = () => {
			setSplitKeyHeld(false);
		};

		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("keyup", handleKeyUp);
		window.addEventListener("blur", handleBlur);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("keyup", handleKeyUp);
			window.removeEventListener("blur", handleBlur);
		};
	}, [
		handleBackspace,
		handleRedo,
		handleUndo,
		playhead,
		seekTo,
		splitButtonHeld,
		splitKeyHeld,
		splitToggle,
		togglePlayPause,
		updateZoomAround,
	]);

	return (
		<div className="flex min-h-screen flex-col bg-gray-1 text-gray-12">
			<header className="sticky top-0 z-30 border-b border-gray-4 bg-white/85 backdrop-blur">
				<div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-2 px-3 sm:h-16 sm:px-5">
					<div className="flex items-center gap-1.5">
						<button
							type="button"
							onClick={handleCancel}
							className="inline-flex h-9 items-center rounded-full bg-gray-3 px-4 text-[14px] font-medium text-gray-12 shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-1px_0_rgba(0,0,0,0.02)] ring-1 ring-gray-5 transition hover:bg-gray-4 active:bg-gray-5"
						>
							Cancel
						</button>
						<button
							type="button"
							aria-label="Restore original"
							title="Restore original"
							disabled={!canRestore || isSaving || isRestoring}
							onClick={() => setShowRestoreConfirm(true)}
							className="inline-flex h-9 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium text-gray-11 transition hover:bg-gray-3 hover:text-gray-12 active:bg-gray-4 disabled:pointer-events-none disabled:opacity-30 sm:px-3"
						>
							<RotateCcw className="size-4" aria-hidden />
							<span className="hidden sm:inline">Restore</span>
						</button>
						<VideoDownloadMenu
							videoId={video.id}
							hasEdits={hasExistingEdits}
							align="start"
						/>
					</div>
					<div className="min-w-0 flex-1 px-2 text-center">
						<h1 className="truncate text-[15px] font-semibold text-gray-12">
							{video.name}
						</h1>
					</div>
					<div className="flex items-center gap-1">
						<HeaderIconButton
							label="Undo"
							disabled={!canUndo}
							onClick={handleUndo}
						>
							<Undo2 className="size-[18px]" />
						</HeaderIconButton>
						<HeaderIconButton
							label="Redo"
							disabled={!canRedo}
							onClick={handleRedo}
						>
							<Redo2 className="size-[18px]" />
						</HeaderIconButton>
						<Button
							variant="blue"
							size="sm"
							spinner={isSaving}
							disabled={isSaving || isRestoring || keepRanges.length === 0}
							onClick={handleDone}
							className="ml-1"
						>
							{isSaving ? "Saving" : "Done"}
						</Button>
					</div>
				</div>
			</header>

			<main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-3 pt-3 pb-4 sm:px-5 sm:pt-4 sm:pb-5">
				<section className="flex min-h-0 flex-1 items-center justify-center">
					<div
						className="relative max-h-full max-w-full overflow-hidden rounded-xl bg-black ring-1 ring-gray-5 [&_[data-slot=media-player-controls]]:!hidden"
						style={{
							aspectRatio:
								video.width && video.height
									? `${video.width} / ${video.height}`
									: "16 / 9",
							width:
								video.width && video.height
									? `min(100%, calc(65vh * ${video.width} / ${video.height}))`
									: "100%",
							viewTransitionName: "cap-edit-video",
							boxShadow: [
								"0 1px 2px rgba(15,23,42,0.05)",
								"0 4px 12px -2px rgba(15,23,42,0.08)",
								"0 24px 48px -12px rgba(15,23,42,0.10)",
							].join(", "),
						}}
					>
						<CapVideoPlayer
							videoSrc={playbackSrc}
							videoId={video.id}
							chaptersSrc=""
							captionsSrc=""
							disableCaptions
							videoRef={videoRef}
							mediaPlayerClassName="h-full w-full"
							enableCrossOrigin
							hasActiveUpload={false}
							disableCommentStamps
							disableReactionStamps
							disablePreviewGif
							duration={video.duration}
							showFloatingVolumeControl
						/>
					</div>
				</section>

				<div className="relative mt-11 flex items-center gap-2.5 sm:mt-12 sm:gap-3">
					<button
						type="button"
						aria-label={isPlaying ? "Pause" : "Play"}
						onClick={togglePlayPause}
						style={{
							boxShadow: [
								"inset 0 1px 0 rgba(255,255,255,0.16)",
								"0 1px 2px rgba(15,23,42,0.10)",
								"0 8px 20px -4px rgba(15,23,42,0.25)",
								"0 16px 32px -10px rgba(15,23,42,0.20)",
							].join(", "),
						}}
						className="flex h-16 w-14 shrink-0 items-center justify-center rounded-lg bg-gray-12 text-white ring-1 ring-gray-12 transition hover:bg-gray-11 active:bg-gray-10 sm:w-16"
					>
						{isPlaying ? (
							<Pause className="size-5" strokeWidth={2.5} aria-hidden />
						) : (
							<Play
								className="size-5 translate-x-0.5"
								strokeWidth={2.5}
								aria-hidden
							/>
						)}
					</button>

					<div className="relative flex-1">
						<div
							ref={scrollContainerRef}
							className={[
								"relative w-full overflow-x-auto overflow-y-hidden rounded-lg bg-gray-12 ring-1 ring-gray-5",
								"[&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20 [&::-webkit-scrollbar-track]:bg-transparent",
								"overscroll-x-contain",
							].join(" ")}
							style={{
								scrollbarColor: "rgba(255,255,255,0.2) transparent",
								boxShadow: [
									"0 1px 2px rgba(15,23,42,0.05)",
									"0 4px 12px -2px rgba(15,23,42,0.08)",
									"0 16px 32px -12px rgba(15,23,42,0.10)",
								].join(", "),
							}}
						>
							<div
								ref={timelineRef}
								onPointerDown={handleTimelinePointerDown}
								className={[
									"relative h-16 select-none",
									splitMode ? "cursor-crosshair" : "cursor-pointer",
								].join(" ")}
								style={{
									width: `${zoom * 100}%`,
									minWidth: "100%",
								}}
							>
								<div className="absolute inset-0 flex">
									{thumbnailSlots.map((slot) => (
										<div
											key={slot.key}
											className="relative min-w-0 flex-1 overflow-hidden border-r border-white/[0.04] bg-gray-12 last:border-r-0"
										>
											{slot.src ? (
												<div
													className="absolute inset-0 bg-cover bg-center opacity-95"
													style={{
														backgroundImage: `url(${JSON.stringify(slot.src)})`,
													}}
												/>
											) : (
												<div className="absolute inset-0 bg-gradient-to-br from-gray-11 to-gray-12" />
											)}
										</div>
									))}
								</div>

								<div
									className="pointer-events-none absolute inset-y-0 left-0 bg-black/70"
									style={{
										width: `${trimStartPct}%`,
									}}
								/>
								<div
									className="pointer-events-none absolute inset-y-0 right-0 bg-black/70"
									style={{
										width: `${100 - trimEndPct}%`,
									}}
								/>

								{visibleSegmentCount > 1 &&
									timelineDisplaySegments.map((segment) => {
										const isActive = activeSegmentAtPlayhead?.id === segment.id;
										return (
											<div
												key={`segment-${segment.id}`}
												className={[
													"pointer-events-none absolute inset-y-0 z-[5] transition-colors",
													isActive
														? "bg-white/[0.14] outline outline-2 -outline-offset-2 outline-white/85"
														: "bg-black/45",
												].join(" ")}
												style={{
													left: `${getTimePercent(segment.displayStart, timelineDisplayDuration)}%`,
													width: `${getTimePercent(segment.displayEnd - segment.displayStart, timelineDisplayDuration)}%`,
												}}
											/>
										);
									})}

								{timelineDisplaySplitPoints.map((splitPoint, index) => {
									const isSelected = selectedSplitIndex === index;
									const isAnySelected = selectedSplitIndex !== null;
									const dimmed = isAnySelected && !isSelected;
									const positionPercent = getTimePercent(
										splitPoint.time,
										timelineDisplayDuration,
									);
									return (
										<Fragment key={splitPoint.id}>
											<button
												type="button"
												aria-label={`Split at ${formatTime(splitPoint.sourceTime)}`}
												aria-pressed={isSelected}
												data-trim-handle
												onPointerDown={(event) => {
													startSplitDrag(
														index,
														splitPoint.sourceTime,
														"center",
														event,
													);
												}}
												className={[
													"group absolute inset-y-0 flex w-6 -translate-x-1/2 cursor-col-resize touch-none items-stretch justify-center",
													isSelected ? "z-[12]" : "z-[8]",
													dimmed ? "opacity-35" : "",
												].join(" ")}
												style={{ left: `${positionPercent}%` }}
											>
												<span
													className={[
														"pointer-events-none absolute left-1/2 -translate-x-1/2 rounded bg-pink-500 shadow-[0_1px_3px_rgba(0,0,0,0.5),0_0_10px_rgba(236,72,153,0.65)] transition-all",
														isSelected
															? "-top-2 h-2 w-5"
															: "-top-1.5 h-1.5 w-4 group-hover:-top-2 group-hover:h-2 group-hover:w-5",
													].join(" ")}
												/>
												<span
													className={[
														"pointer-events-none absolute left-1/2 -translate-x-1/2 rounded bg-pink-500 shadow-[0_1px_3px_rgba(0,0,0,0.5),0_0_10px_rgba(236,72,153,0.65)] transition-all",
														isSelected
															? "-bottom-2 h-2 w-5"
															: "-bottom-1.5 h-1.5 w-4 group-hover:-bottom-2 group-hover:h-2 group-hover:w-5",
													].join(" ")}
												/>
												<span
													className={[
														"pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 bg-pink-500 shadow-[0_0_10px_rgba(236,72,153,0.7)] transition-all",
														isSelected
															? "w-[5px] ring-2 ring-pink-300/40"
															: "w-1 group-hover:w-[5px]",
													].join(" ")}
												/>
											</button>
											<button
												type="button"
												aria-label="Remove split"
												title="Remove split"
												data-trim-handle
												onPointerDown={(event) => event.stopPropagation()}
												onClick={(event) => {
													event.stopPropagation();
													removeSplitAtIndex(index);
												}}
												className={[
													"absolute -top-9 left-0 z-[50] flex -translate-x-1/2 items-center justify-center rounded-full bg-pink-500 text-white shadow-[0_2px_6px_rgba(0,0,0,0.5),0_0_10px_rgba(236,72,153,0.6)] ring-1 ring-black/40 transition-all hover:bg-pink-400 active:bg-pink-600",
													isSelected
														? "size-5 opacity-100"
														: "size-4 opacity-70 hover:scale-110 hover:opacity-100",
													dimmed ? "opacity-25" : "",
												].join(" ")}
												style={{ left: `${positionPercent}%` }}
											>
												<X
													className={isSelected ? "size-3" : "size-2.5"}
													strokeWidth={3}
													aria-hidden
												/>
											</button>
										</Fragment>
									);
								})}

								<div
									className="pointer-events-none absolute inset-y-0 z-[10]"
									style={{
										left: `${trimStartPct}%`,
										width: `${trimWidthPct}%`,
									}}
								>
									<div className="absolute inset-x-0 top-0 h-1.5 bg-blue-500" />
									<div className="absolute inset-x-0 bottom-0 h-1.5 bg-blue-500" />
								</div>

								<button
									type="button"
									aria-label="Trim start"
									data-trim-handle
									onPointerDown={(event) => startHandleDrag("start", event)}
									className={[
										"absolute inset-y-0 z-20 flex w-6 cursor-ew-resize touch-none items-center justify-center rounded-l-lg bg-blue-500 text-white shadow-[0_1px_2px_rgba(0,0,0,0.3),0_2px_8px_-1px_rgba(59,130,246,0.55)] transition hover:bg-blue-400 active:bg-blue-600",
										activeHandle === "start"
											? "ring-2 ring-blue-300 ring-inset"
											: "",
									].join(" ")}
									style={{
										left: `${trimStartPct}%`,
									}}
								>
									<ChevronLeft className="size-5" strokeWidth={3} aria-hidden />
								</button>
								<button
									type="button"
									aria-label="Trim end"
									data-trim-handle
									onPointerDown={(event) => startHandleDrag("end", event)}
									className={[
										"absolute inset-y-0 z-20 flex w-6 -translate-x-full cursor-ew-resize touch-none items-center justify-center rounded-r-lg bg-blue-500 text-white shadow-[0_1px_2px_rgba(0,0,0,0.3),0_2px_8px_-1px_rgba(59,130,246,0.55)] transition hover:bg-blue-400 active:bg-blue-600",
										activeHandle === "end"
											? "ring-2 ring-blue-300 ring-inset"
											: "",
									].join(" ")}
									style={{
										left: `${trimEndPct}%`,
									}}
								>
									<ChevronRight
										className="size-5"
										strokeWidth={3}
										aria-hidden
									/>
								</button>
							</div>
						</div>

						<div className="pointer-events-none absolute bottom-0 left-0 right-0 z-40 h-[92px] overflow-hidden">
							<div
								ref={playheadOverlayRef}
								className="absolute bottom-0 left-0 h-[92px] will-change-transform"
								style={{
									transform: "translate3d(-9999px, 0, 0) translateX(-50%)",
								}}
							>
								{selectedSplitIndex === null && (
									<div className="absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap rounded-md bg-white px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-black shadow-[0_2px_8px_rgba(0,0,0,0.45)]">
										{formatTimeDetailed(outputPlayhead)}
									</div>
								)}
								<div className="absolute left-1/2 top-6 size-2.5 -translate-x-1/2 rounded-full bg-white shadow-[0_0_0_1.5px_rgba(0,0,0,0.55),0_2px_4px_rgba(0,0,0,0.45)]" />
								<div className="absolute bottom-0 left-1/2 top-[34px] w-[2.5px] -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.55),0_0_4px_rgba(0,0,0,0.3)]" />
							</div>
						</div>
					</div>
				</div>

				<div className="mt-4 flex items-center justify-between gap-3 px-1 sm:mt-5">
					<button
						type="button"
						title="Click to split — hold to add multiple"
						onPointerDown={handleSplitButtonPointerDown}
						onPointerUp={handleSplitButtonPointerUp}
						className={[
							"inline-flex h-9 select-none items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition",
							splitMode
								? "bg-pink-500 text-white shadow-[0_2px_8px_-2px_rgba(236,72,153,0.6)]"
								: "text-gray-12 hover:bg-gray-3 active:bg-gray-4",
						].join(" ")}
					>
						<Scissors className="size-3.5" aria-hidden />
						<span>{splitMode ? "Cancel split" : "Split"}</span>
					</button>

					<div className="flex items-center gap-3">
						<div className="inline-flex items-baseline gap-1.5 font-mono text-[12px] tabular-nums">
							<span className="font-semibold text-gray-12">
								{formatTime(outputPlayhead)}
							</span>
							<span className="text-gray-9">/</span>
							<span
								className={
									outputDuration < video.duration - 0.05
										? "font-semibold text-blue-600"
										: "text-gray-10"
								}
							>
								{formatTime(outputDuration)}
							</span>
						</div>

						<div className="hidden sm:block h-5 w-px bg-gray-5" />

						<div className="hidden sm:flex items-center gap-1.5">
							<button
								type="button"
								aria-label="Zoom out"
								title="Zoom out (−)"
								onClick={() => updateZoomAround(zoom / 1.25)}
								disabled={zoom <= MIN_ZOOM + 0.01}
								className="inline-flex size-7 items-center justify-center rounded-full text-gray-12 transition hover:bg-gray-3 active:bg-gray-4 disabled:pointer-events-none disabled:opacity-30"
							>
								<Minus className="size-3.5" />
							</button>
							<input
								type="range"
								aria-label="Zoom level"
								min={MIN_ZOOM}
								max={MAX_ZOOM}
								step={0.25}
								value={zoom}
								onChange={(event) =>
									updateZoomAround(Number.parseFloat(event.target.value))
								}
								className="h-1 w-28 cursor-pointer appearance-none rounded-full bg-gray-5 accent-gray-12 [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gray-12 [&::-webkit-slider-thumb]:shadow [&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-gray-12"
							/>
							<button
								type="button"
								aria-label="Zoom in"
								title="Zoom in (+)"
								onClick={() => updateZoomAround(zoom * 1.25)}
								disabled={zoom >= MAX_ZOOM - 0.01}
								className="inline-flex size-7 items-center justify-center rounded-full text-gray-12 transition hover:bg-gray-3 active:bg-gray-4 disabled:pointer-events-none disabled:opacity-30"
							>
								<Plus className="size-3.5" />
							</button>
						</div>
					</div>

					<ToolButton
						tone="danger"
						disabled={!canDeleteSegment}
						onClick={handleDelete}
						icon={<Trash2 className="size-3.5" aria-hidden />}
						label="Delete"
					/>
				</div>
			</main>

			<Dialog
				open={showRestoreConfirm}
				onOpenChange={(open) => {
					if (isRestoring) return;
					setShowRestoreConfirm(open);
				}}
			>
				<DialogContent className="max-w-sm p-0">
					<DialogHeader icon={<RotateCcw className="size-5" />}>
						<DialogTitle>Restore original video?</DialogTitle>
					</DialogHeader>
					<DialogDescription>
						This discards your current edits and restores the video to its
						original recording. This can't be undone.
					</DialogDescription>
					<DialogFooter>
						<Button
							variant="gray"
							size="sm"
							disabled={isRestoring}
							onClick={() => setShowRestoreConfirm(false)}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							size="sm"
							spinner={isRestoring}
							disabled={isRestoring}
							onClick={handleRestore}
						>
							{isRestoring ? "Restoring" : "Restore original"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
