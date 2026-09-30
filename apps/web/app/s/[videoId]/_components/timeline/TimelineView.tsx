"use client";

import type { Video } from "@cap/web-domain";
import { motion, useReducedMotion } from "motion/react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommentType } from "../../Share";
import { usePlayback } from "../playback/PlaybackContext";
import { filmstripTileCount } from "./filmstrip-math";
import { TimelineActiveCue } from "./TimelineActiveCue";
import { TimelineBranches } from "./TimelineBranches";
import {
	type TimelineChapter,
	TimelineChapterTicks,
} from "./TimelineChapterTicks";
import { type RecordIntentKind, TimelineComposer } from "./TimelineComposer";
import { TimelineHoverGhost } from "./TimelineHoverGhost";
import { TimelineMobileSheet } from "./TimelineMobileSheet";
import { TimelinePlayhead } from "./TimelinePlayhead";
import {
	TimelineProvider,
	useMediaQuery,
	useTimelineActions,
	useTimelineWindow,
	useTimelineWindowRef,
} from "./TimelineProvider";
import { TimelineRail } from "./TimelineRail";
import { TimelineRuler } from "./TimelineRuler";
import { TimelineZoomControls } from "./TimelineZoomControls";
import {
	KEYBOARD_SEEK_STEP,
	LANE_STEM,
	LANE_STEM_MOBILE,
	MIN_NODE_GAP,
	MIN_NODE_GAP_MOBILE,
	NODE_SIZE,
	quantizeWidth,
	stripHeight,
	timeFromClientX,
	usableWidth,
} from "./timeline-constants";
import { layoutBranches } from "./timeline-layout";
import { followWindow, isFullWindow } from "./timeline-window";
import { type FilmstripSource, useFilmstripFrames } from "./useFilmstripFrames";
import { useTimelineWaveform } from "./useTimelineWaveform";

export { TimelineSkeleton } from "./TimelineSkeleton";

// Capture + upload code loads only when someone actually presses record.
const RecorderSurface = dynamic(() => import("./recording/RecorderSurface"), {
	ssr: false,
});

const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

const EMPTY_CHAPTERS: TimelineChapter[] = [];

/** Wheel deltas are device-dependent; this keeps a notch from jumping a decade. */
const WHEEL_ZOOM_RATE = 0.012;
const WHEEL_ZOOM_MAX = 1.6;

export interface TimelineViewProps {
	comments: CommentType[];
	videoId: Video.VideoId;
	chapters?: { title: string; start: number }[];
	/** Drives the strip's waveform: a transcript when there is one. */
	transcriptionStatus?: string | null;
	/**
	 * Where the filmstrip's preview frames come from. Omitted (e.g. while an
	 * upload is still in flight) the strip falls back to a quiet placeholder.
	 */
	filmstripSource?: FilmstripSource | null;
	onOptimisticComment?: (comment: CommentType) => void;
	onCommentSuccess?: (comment: CommentType) => void;
	canRecordMedia?: boolean;
	viewerSignedIn?: boolean;
	/** Owner/org viewer setting: emoji reactions are hidden when set. */
	disableReactions?: boolean;
	/**
	 * Fires when a recording flow starts/ends so the host can lock the view
	 * toggle (leaving the timeline would discard the take).
	 */
	onRecordingActiveChange?: (active: boolean) => void;
	/**
	 * Supplied by the recording phase. Until it arrives the composer hides its
	 * capture buttons but keeps the row, so wiring this up later moves nothing.
	 */
	onRecordIntent?: (kind: RecordIntentKind, t: number) => void;
	/**
	 * Hands the host the element the video player's own control bar portals
	 * into: the row closing the bottom of the card. The deck has no transport
	 * of its own — one player, one set of controls.
	 */
	onControlsSlotChange?: (el: HTMLElement | null) => void;
}

/**
 * The timeline band under the video: the filmstrip fixed to the video's bottom
 * edge, the transport under it, and comments branching down off the ruler.
 *
 * Read-only with respect to the player — it drives the shared playback store
 * rather than owning a video element — and deliberately render-quiet. While the
 * video plays only `TimelineActiveCue` and `TimelineTransport` re-render; the
 * playhead, the rail fill and the hover ghost all write to the DOM directly.
 */
export default function TimelineView(props: TimelineViewProps) {
	const reduceMotion = useReducedMotion() ?? false;
	const isDesktop = useMediaQuery("(min-width: 1024px)", true);
	const hasHover = useMediaQuery("(hover: hover) and (pointer: fine)", true);
	const playback = usePlayback();

	// Duration is read off the store rather than held in state, and only
	// promoted to state when it actually changes: the subscriber below fires
	// every frame during playback and must not re-render the deck each time.
	// It lives up here because the provider clamps the zoom window against it.
	const [duration, setDuration] = useState(() => playback.getDuration());
	const durationRef = useRef(duration);

	useEffect(
		() =>
			playback.subscribe(() => {
				const next = playback.getDuration();
				if (Math.abs(next - durationRef.current) < 0.001) return;
				durationRef.current = next;
				setDuration(next);
			}),
		[playback],
	);

	return (
		<motion.div
			// Slides down from beneath the stage rather than up from the page:
			// the band is the bottom half of the player strip, and the brief
			// overlap during the move is white-on-white, so it reads as unfolding.
			initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -14 }}
			animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
			exit={
				reduceMotion
					? { opacity: 0, transition: { duration: 0 } }
					: { opacity: 0, y: -10, transition: { duration: 0.16, ease: EASE } }
			}
			transition={
				reduceMotion ? { duration: 0 } : { duration: 0.32, ease: EASE }
			}
			data-timeline-view=""
			// Transparent: the band is the lower body of the player card the host
			// grid draws, so the card's colour and corners show through.
			className="relative w-full"
		>
			<TimelineProvider
				compact={!isDesktop}
				hasHover={hasHover}
				duration={duration}
			>
				<TimelineBand
					{...props}
					compact={!isDesktop}
					hasHover={hasHover}
					duration={duration}
				/>
			</TimelineProvider>
		</motion.div>
	);
}

/**
 * Everything below the provider, so the band can reach timeline UI state
 * (the composer anchor, the zoom window) through the same hooks its children
 * use.
 */
function TimelineBand({
	comments,
	videoId,
	chapters = EMPTY_CHAPTERS,
	transcriptionStatus,
	filmstripSource = null,
	onOptimisticComment,
	onCommentSuccess,
	canRecordMedia = false,
	viewerSignedIn = false,
	disableReactions = false,
	onRecordingActiveChange,
	onRecordIntent,
	onControlsSlotChange,
	compact,
	hasHover,
	duration,
}: TimelineViewProps & {
	compact: boolean;
	hasHover: boolean;
	duration: number;
}) {
	const playback = usePlayback();
	const {
		openComposer,
		closeComposer,
		zoomAtTime,
		panBy,
		resetZoom,
		setWindow,
	} = useTimelineActions();
	const { start: windowStart, end: windowEnd } = useTimelineWindow();
	const windowRef = useTimelineWindowRef();
	const [recordIntent, setRecordIntent] = useState<{
		kind: RecordIntentKind;
		t: number;
	} | null>(null);

	const internalRecordIntent = useCallback(
		(kind: RecordIntentKind, t: number) => {
			playback.pause();
			closeComposer();
			setRecordIntent({ kind, t });
		},
		[playback, closeComposer],
	);

	useEffect(() => {
		onRecordingActiveChange?.(recordIntent !== null);
		return () => onRecordingActiveChange?.(false);
	}, [recordIntent, onRecordingActiveChange]);

	const stripRef = useRef<HTMLDivElement | null>(null);
	const railRef = useRef<HTMLDivElement | null>(null);
	const commentsRef = useRef<HTMLDivElement | null>(null);
	const widthRef = useRef(0);
	const [trackWidth, setTrackWidth] = useState(0);

	// Stable identity: an inline ref callback would re-fire (null, el) on every
	// zoom-driven render and thrash the host's state.
	const onControlsSlotChangeRef = useRef(onControlsSlotChange);
	onControlsSlotChangeRef.current = onControlsSlotChange;
	const controlsSlotRef = useCallback(
		(el: HTMLElement | null) => onControlsSlotChangeRef.current?.(el),
		[],
	);

	const durationRef = useRef(duration);
	durationRef.current = duration;

	useEffect(() => {
		const strip = stripRef.current;
		if (!strip) return;

		const measure = (width: number) => {
			widthRef.current = width;
			setTrackWidth((prev) => {
				const next = quantizeWidth(width);
				return next === prev ? prev : next;
			});
		};

		measure(strip.clientWidth);
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) measure(entry.contentRect.width);
		});
		observer.observe(strip);
		return () => observer.disconnect();
	}, []);

	// Trackpad pinch arrives as a ctrl-wheel, and React's synthetic onWheel is
	// passive, so preventDefault only works from a manually bound listener.
	useEffect(() => {
		const strip = stripRef.current;
		if (!strip) return;

		const handleWheel = (event: WheelEvent) => {
			const total = durationRef.current;
			if (!Number.isFinite(total) || total <= 0) return;
			const window = windowRef.current;

			if (event.ctrlKey || event.metaKey) {
				event.preventDefault();
				const focus = timeFromClientX(
					event.clientX,
					strip.getBoundingClientRect(),
					window.start,
					window.end,
				);
				const factor = Math.min(
					WHEEL_ZOOM_MAX,
					Math.max(
						1 / WHEEL_ZOOM_MAX,
						Math.exp(-event.deltaY * WHEEL_ZOOM_RATE),
					),
				);
				zoomAtTime(factor, focus);
				return;
			}

			const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
			// A plain vertical wheel belongs to the page, not to the deck.
			if (!horizontal && !event.shiftKey) return;
			if (isFullWindow(window, total)) return;

			event.preventDefault();
			const usable = usableWidth(widthRef.current);
			if (usable <= 0) return;
			const delta = horizontal ? event.deltaX : event.deltaY;
			panBy((delta / usable) * (window.end - window.start));
		};

		strip.addEventListener("wheel", handleWheel, { passive: false });
		return () => strip.removeEventListener("wheel", handleWheel);
	}, [zoomAtTime, panBy, windowRef]);

	// Keeps the playhead on screen once a zoom has left it behind, at one
	// state update per crossing rather than one per frame.
	const followedRef = useRef(false);
	useEffect(
		() =>
			playback.subscribe((time) => {
				if (!playback.getPlaying()) return;
				const window = windowRef.current;
				if (time >= window.start && time <= window.end) {
					followedRef.current = false;
					return;
				}
				if (followedRef.current) return;
				const next = followWindow(window, time, durationRef.current);
				if (!next) return;
				followedRef.current = true;
				setWindow(next);
			}),
		[playback, windowRef, setWindow],
	);

	// Replies belong to their parent's card, not to a branch of their own; the
	// disableReactions viewer setting hides emoji everywhere else, so it hides
	// their branches too.
	const rootComments = useMemo(
		() =>
			comments.filter(
				(comment) =>
					!comment.parentCommentId &&
					!(disableReactions && comment.type === "emoji"),
			),
		[comments, disableReactions],
	);

	const replyCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const comment of comments) {
			const parent = comment.parentCommentId;
			if (!parent) continue;
			counts.set(parent, (counts.get(parent) ?? 0) + 1);
		}
		return counts;
	}, [comments]);

	const branches = useMemo(
		() =>
			layoutBranches(
				rootComments,
				{ start: windowStart, end: windowEnd },
				trackWidth,
				compact ? MIN_NODE_GAP_MOBILE : MIN_NODE_GAP,
			),
		[rootComments, windowStart, windowEnd, trackWidth, compact],
	);

	const stems = compact ? LANE_STEM_MOBILE : LANE_STEM;

	// The shelf hugs its content: single-lane days don't pay for lane 1, and
	// with nothing on it the row disappears entirely.
	const shelfHeight =
		branches.length > 0
			? Math.max(...branches.map((node) => stems[node.lane])) +
				NODE_SIZE / 2 +
				12
			: 0;

	// Filmstrip geometry follows the quantised track width, so a resize only
	// re-tiles at the same coarse steps as the layout.
	const stripUsable = usableWidth(trackWidth);
	const tileCount = filmstripTileCount(stripUsable);
	const stripH = stripHeight(compact);
	const tileAspect =
		tileCount > 0 && stripH > 0 ? stripUsable / tileCount / stripH : 16 / 9;
	const filmstrip = useFilmstripFrames({
		source: filmstripSource,
		duration,
		tileCount,
		tileAspect,
		windowStart,
		windowEnd,
	});

	const envelope = useTimelineWaveform({
		videoId,
		transcriptionStatus,
		duration,
	});

	const handleSeek = useCallback(
		(time: number) => playback.seek(time),
		[playback],
	);

	const handleAddAtTime = useCallback(
		(time: number) => {
			playback.pause();
			openComposer(time);
		},
		[playback, openComposer],
	);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			const target = event.target as HTMLElement | null;
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement
			) {
				return;
			}

			if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
				event.preventDefault();
				const delta =
					event.key === "ArrowLeft" ? -KEYBOARD_SEEK_STEP : KEYBOARD_SEEK_STEP;
				playback.seek(playback.getCurrentTime() + delta);
				return;
			}

			// Space over a branch node belongs to that button, not to playback.
			if (event.key === " " || event.key === "Spacebar") {
				if (target?.closest("[data-timeline-node]")) return;
				event.preventDefault();
				if (playback.getPlaying()) playback.pause();
				else playback.play();
			}
		},
		[playback],
	);

	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: delegates keys for the slider it contains. */}
			<div className="flex w-full flex-col" onKeyDown={handleKeyDown}>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: double-click resets a gesture the rail inside already owns. */}
				<div
					ref={stripRef}
					className="relative shrink-0"
					style={{ height: stripH }}
					onDoubleClick={resetZoom}
				>
					<TimelineRail
						duration={duration}
						railRef={railRef}
						filmstrip={filmstrip}
						tileCount={tileCount}
						envelope={envelope}
						windowStart={windowStart}
						windowEnd={windowEnd}
					/>
					<TimelineChapterTicks
						chapters={chapters}
						duration={duration}
						windowStart={windowStart}
						windowEnd={windowEnd}
					/>
					<TimelinePlayhead widthRef={widthRef} />
					<TimelineHoverGhost
						stripRef={stripRef}
						widthRef={widthRef}
						enabled={hasHover && !compact}
						onAddAtTime={handleAddAtTime}
						filmstrip={filmstrip}
						tileCount={tileCount}
					/>
				</div>

				{/*
				 * Comments live between the strip and the control bar, and the row
				 * only exists while something is on it: no branches, no gap, and the
				 * film sits directly on the controls.
				 */}
				<div
					ref={commentsRef}
					className="relative shrink-0 overflow-visible transition-[height] duration-200"
					style={{ height: shelfHeight }}
				>
					{branches.length > 0 && (
						<>
							<TimelineRuler windowStart={windowStart} windowEnd={windowEnd} />
							<TimelineBranches
								branches={branches}
								windowStart={windowStart}
								windowEnd={windowEnd}
								stems={stems}
								trackWidth={trackWidth}
								shelfHeight={shelfHeight}
								replyCounts={replyCounts}
								onSeek={handleSeek}
							/>
						</>
					)}
					<TimelineComposer
						videoId={videoId}
						trackWidth={trackWidth}
						windowStart={windowStart}
						windowEnd={windowEnd}
						viewerSignedIn={viewerSignedIn}
						onOptimisticComment={onOptimisticComment}
						onCommentSuccess={onCommentSuccess}
						onRecordIntent={
							canRecordMedia
								? (onRecordIntent ?? internalRecordIntent)
								: undefined
						}
					/>
				</div>

				{/* The card's bottom row: the player's own control bar portals into
				    the slot (context survives portals, so every button keeps its
				    store) in its light tone, and the rounded corners close the unit.
				    The hairline stands in for the strip's bottom edge when the
				    comments shelf is collapsed and the film sits straight on it. */}
				<div className="flex h-14 shrink-0 items-center gap-1 rounded-b-xl border-t border-gray-4 bg-white">
					<div
						ref={controlsSlotRef}
						className="relative h-full min-w-0 flex-1"
					/>
					{/*
					 * Touch replacement for the hover ghost: without a hover pointer
					 * (or below lg) there is no "add here" affordance on the strip, so
					 * the bar carries one that opens the composer at the playhead.
					 */}
					{!(hasHover && !compact) && (
						<button
							type="button"
							aria-label="Comment at current time"
							title="Comment at current time"
							onClick={() => handleAddAtTime(playback.getCurrentTime())}
							className="flex size-8 shrink-0 items-center justify-center rounded-full text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
						>
							<svg
								viewBox="0 0 16 16"
								className="size-4 fill-current"
								aria-hidden
							>
								<title>Add comment</title>
								<path d="M8 1.5c-3.6 0-6.5 2.5-6.5 5.6 0 1.8 1 3.4 2.5 4.4-.1.8-.5 1.6-1.1 2.3-.2.2 0 .6.3.6 1.4-.1 2.6-.6 3.5-1.3.4.1.8.1 1.3.1 3.6 0 6.5-2.5 6.5-5.6S11.6 1.5 8 1.5Zm.6 3.4v1.5h1.5a.6.6 0 1 1 0 1.2H8.6v1.5a.6.6 0 1 1-1.2 0V7.6H5.9a.6.6 0 1 1 0-1.2h1.5V4.9a.6.6 0 1 1 1.2 0Z" />
							</svg>
						</button>
					)}
					<TimelineZoomControls />
				</div>
			</div>

			{recordIntent && (
				<RecorderSurface
					kind={recordIntent.kind}
					timestamp={recordIntent.t}
					videoId={videoId}
					onOptimisticComment={onOptimisticComment}
					onCommentSuccess={onCommentSuccess}
					onClose={() => setRecordIntent(null)}
				/>
			)}
			<TimelineMobileSheet branches={branches} onSeek={handleSeek} />
			<TimelineActiveCue branches={branches} containerRef={commentsRef} />
		</>
	);
}
