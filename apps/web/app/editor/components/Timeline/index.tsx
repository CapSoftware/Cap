"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatTime } from "../../utils/time";
import { useEditorContext } from "../context";
import {
	MAX_TIMELINE_MARKINGS,
	TimelineContextProvider,
	useTimelineContext,
} from "./context";

const TIMELINE_PADDING = 16;
const TRACK_GUTTER = 64;
const TIMELINE_HEADER_HEIGHT = 32;
const TRACK_HEIGHT = 48;

export function Timeline() {
	const { video, editorState, setEditorState, actions, project } =
		useEditorContext();
	const duration = video.duration;
	const transform = editorState.timeline.transform;

	const timelineRef = useRef<HTMLDivElement>(null);
	const [timelineBounds, setTimelineBounds] = useState<{
		width: number;
		height: number;
		left: number;
		top: number;
	} | null>(null);

	useEffect(() => {
		const updateBounds = () => {
			if (timelineRef.current) {
				const rect = timelineRef.current.getBoundingClientRect();
				setTimelineBounds({
					width: rect.width,
					height: rect.height,
					left: rect.left,
					top: rect.top,
				});
			}
		};

		updateBounds();
		const observer = new ResizeObserver(updateBounds);
		if (timelineRef.current) {
			observer.observe(timelineRef.current);
		}

		window.addEventListener("resize", updateBounds);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", updateBounds);
		};
	}, []);

	const secsPerPixel = useMemo(() => {
		if (!timelineBounds?.width) return 1;
		return transform.zoom / timelineBounds.width;
	}, [transform.zoom, timelineBounds?.width]);

	const handleUpdatePlayhead = useCallback(
		(e: React.MouseEvent) => {
			if (!timelineBounds) return;
			const offsetX = e.clientX - timelineBounds.left;
			const time = transform.position + secsPerPixel * offsetX;
			const clampedTime = Math.max(0, Math.min(duration, time));
			actions.seekTo(clampedTime);
		},
		[timelineBounds, transform.position, secsPerPixel, duration, actions],
	);

	const handleWheel = useCallback(
		(e: React.WheelEvent) => {
			e.preventDefault();
			if (e.ctrlKey || e.metaKey) {
				const zoomDelta = (e.deltaY * Math.sqrt(transform.zoom)) / 30;
				const newZoom = Math.max(
					1,
					Math.min(duration, transform.zoom + zoomDelta),
				);

				const previewTime = editorState.previewTime ?? editorState.playbackTime;
				const ratio = timelineBounds?.width
					? (previewTime - transform.position) / transform.zoom
					: 0.5;
				const newPosition = Math.max(
					0,
					Math.min(duration - newZoom, previewTime - ratio * newZoom),
				);

				setEditorState((state) => ({
					...state,
					timeline: {
						...state.timeline,
						transform: { position: newPosition, zoom: newZoom },
					},
				}));
			} else {
				const scrollDelta = e.deltaX || e.deltaY;
				const positionDelta = secsPerPixel * scrollDelta;
				const newPosition = Math.max(
					0,
					Math.min(
						duration - transform.zoom,
						transform.position + positionDelta,
					),
				);

				setEditorState((state) => ({
					...state,
					timeline: {
						...state.timeline,
						transform: { ...state.timeline.transform, position: newPosition },
					},
				}));
			}
		},
		[
			transform,
			duration,
			secsPerPixel,
			timelineBounds,
			editorState.previewTime,
			editorState.playbackTime,
			setEditorState,
		],
	);

	const handleMouseMove = useCallback(
		(e: React.MouseEvent) => {
			if (!timelineBounds || editorState.playing) return;
			const offsetX = e.clientX - timelineBounds.left;
			if (offsetX < 0 || offsetX > timelineBounds.width) {
				setEditorState((state) => ({ ...state, previewTime: 0 }));
				return;
			}
			const previewTime = transform.position + secsPerPixel * offsetX;
			setEditorState((state) => ({
				...state,
				previewTime: Math.max(0, Math.min(duration, previewTime)),
			}));
		},
		[
			timelineBounds,
			transform.position,
			secsPerPixel,
			duration,
			editorState.playing,
			setEditorState,
		],
	);

	const playheadPosition = useMemo(() => {
		if (!timelineBounds?.width) return 0;
		const time = editorState.playbackTime;
		const position = (time - transform.position) / secsPerPixel;
		return Math.max(0, Math.min(position, timelineBounds.width));
	}, [
		editorState.playbackTime,
		transform.position,
		secsPerPixel,
		timelineBounds?.width,
	]);

	const previewPosition = useMemo(() => {
		if (!timelineBounds?.width || editorState.playing) return null;
		const time = editorState.previewTime;
		if (time <= 0) return null;
		const position = (time - transform.position) / secsPerPixel;
		if (position < 0 || position > timelineBounds.width) return null;
		return position;
	}, [
		editorState.previewTime,
		editorState.playing,
		transform.position,
		secsPerPixel,
		timelineBounds?.width,
	]);

	const segments = project.timeline?.segments ?? [
		{ start: 0, end: duration, timescale: 1 },
	];

	return (
		<TimelineContextProvider duration={duration}>
			<div
				className="relative flex flex-col h-full bg-gray-2 border-t border-gray-4 overflow-hidden"
				style={{
					paddingLeft: TIMELINE_PADDING,
					paddingRight: TIMELINE_PADDING,
				}}
				onWheel={handleWheel}
				onMouseMove={handleMouseMove}
				onMouseLeave={() =>
					setEditorState((state) => ({ ...state, previewTime: 0 }))
				}
			>
				<div
					className="relative flex items-end"
					style={{ height: TIMELINE_HEADER_HEIGHT, marginLeft: TRACK_GUTTER }}
				>
					<TimelineMarkings
						transform={transform}
						secsPerPixel={secsPerPixel}
						duration={duration}
					/>
				</div>

				<div className="relative flex-1 min-h-0">
					{previewPosition !== null && (
						<div
							className="absolute top-0 bottom-0 w-px bg-gray-8 pointer-events-none z-10"
							style={{
								left: TRACK_GUTTER,
								transform: `translateX(${previewPosition}px)`,
							}}
						>
							<div className="absolute -top-2 left-1/2 -translate-x-1/2 size-3 rounded-full bg-gray-8" />
						</div>
					)}

					<div
						className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none z-20"
						style={{
							left: TRACK_GUTTER,
							transform: `translateX(${playheadPosition}px)`,
						}}
					>
						<div className="absolute -top-2 left-1/2 -translate-x-1/2 size-3 rounded-full bg-red-500" />
					</div>

					<div className="flex items-stretch gap-2 h-full">
						<div
							className="flex items-center justify-center text-gray-11"
							style={{ width: TRACK_GUTTER - 8 }}
						>
							<svg
								className="size-4"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
							>
								<rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
								<line x1="7" y1="2" x2="7" y2="22" />
								<line x1="17" y1="2" x2="17" y2="22" />
								<line x1="2" y1="12" x2="22" y2="12" />
								<line x1="2" y1="7" x2="7" y2="7" />
								<line x1="2" y1="17" x2="7" y2="17" />
								<line x1="17" y1="7" x2="22" y2="7" />
								<line x1="17" y1="17" x2="22" y2="17" />
							</svg>
						</div>

						<div
							ref={timelineRef}
							className="flex-1 relative cursor-pointer"
							onClick={handleUpdatePlayhead}
							style={{ height: TRACK_HEIGHT }}
						>
							<ClipTrack
								segments={segments}
								transform={transform}
								secsPerPixel={secsPerPixel}
								duration={duration}
							/>
						</div>
					</div>
				</div>
			</div>
		</TimelineContextProvider>
	);
}

interface TimelineMarkingsProps {
	transform: { position: number; zoom: number };
	secsPerPixel: number;
	duration: number;
}

function TimelineMarkings({
	transform,
	secsPerPixel,
	duration,
}: TimelineMarkingsProps) {
	const markingResolutions = [0.5, 1, 2.5, 5, 10, 30];
	const markingResolution =
		markingResolutions.find(
			(r) => transform.zoom / r <= MAX_TIMELINE_MARKINGS,
		) ?? 30;

	const markingCount = Math.ceil(2 + (transform.zoom + 5) / markingResolution);
	const markingOffset = transform.position % markingResolution;

	const markings = useMemo(() => {
		const result = [];
		for (let i = 0; i < markingCount; i++) {
			const time = transform.position - markingOffset + i * markingResolution;
			if (time > 0 && time <= duration) {
				result.push({
					time,
					x: (time - transform.position) / secsPerPixel,
					showLabel: time % 1 === 0,
				});
			}
		}
		return result;
	}, [
		transform.position,
		markingOffset,
		markingResolution,
		markingCount,
		secsPerPixel,
		duration,
	]);

	return (
		<div className="relative flex-1 h-4 text-xs text-gray-9">
			{markings.map((marking) => (
				<div
					key={marking.time}
					className="absolute bottom-1 w-1 h-1 bg-current rounded-full"
					style={{ transform: `translateX(${marking.x}px)` }}
				>
					{marking.showLabel && (
						<div className="absolute -top-4 -translate-x-1/2 whitespace-nowrap">
							{formatTime(marking.time)}
						</div>
					)}
				</div>
			))}
		</div>
	);
}

interface ClipTrackProps {
	segments: ReadonlyArray<{ start: number; end: number; timescale: number }>;
	transform: { position: number; zoom: number };
	secsPerPixel: number;
	duration: number;
}

function ClipTrack({
	segments,
	transform,
	secsPerPixel,
	duration,
}: ClipTrackProps) {
	const visibleRange = {
		start: Math.max(0, transform.position - 2),
		end: Math.min(duration, transform.position + transform.zoom + 2),
	};

	return (
		<div className="absolute inset-0 flex items-center">
			{segments.map((segment, index) => {
				if (
					segment.end < visibleRange.start ||
					segment.start > visibleRange.end
				) {
					return null;
				}

				const startX = (segment.start - transform.position) / secsPerPixel;
				const width = (segment.end - segment.start) / secsPerPixel;

				return (
					<div
						key={index}
						className="absolute h-full rounded-md bg-blue-500/30 border border-blue-500/50"
						style={{
							left: `${Math.max(0, startX)}px`,
							width: `${width}px`,
						}}
					>
						<div className="absolute inset-0 flex items-center justify-center text-xs text-blue-300 truncate px-2">
							{segment.timescale !== 1 && `${segment.timescale}x`}
						</div>
					</div>
				);
			})}
		</div>
	);
}

export { TimelineContextProvider, useTimelineContext } from "./context";
