"use client";

import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { formatTime } from "../../utils/time";
import type { WaveformData } from "../../utils/waveform";
import { useEditorContext } from "../context";
import { ClipSegment } from "./ClipSegment";
import { MAX_TIMELINE_MARKINGS, TimelineContextProvider } from "./context";
import { Playhead } from "./Playhead";

const TIMELINE_PADDING = 16;
const TRACK_GUTTER = 64;
const TIMELINE_HEADER_HEIGHT = 32;
const TRACK_HEIGHT = 48;

export function Timeline() {
	const {
		video,
		editorState,
		setEditorState,
		actions,
		project,
		setProjectWithoutHistory,
		waveformData,
		history,
	} = useEditorContext();
	const duration = video.duration;
	const transform = editorState.timeline.transform;
	const selection = editorState.timeline.selection;

	const timelineRef = useRef<HTMLDivElement>(null);
	const [timelineBounds, setTimelineBounds] = useState<{
		width: number;
		height: number;
		left: number;
		top: number;
	} | null>(null);

	useLayoutEffect(() => {
		const updateBounds = () => {
			if (timelineRef.current) {
				const rect = timelineRef.current.getBoundingClientRect();
				setTimelineBounds((previous) => {
					if (
						previous &&
						previous.width === rect.width &&
						previous.height === rect.height &&
						previous.left === rect.left &&
						previous.top === rect.top
					) {
						return previous;
					}

					return {
						width: rect.width,
						height: rect.height,
						left: rect.left,
						top: rect.top,
					};
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

	const handleSelectSegment = useCallback(
		(index: number) => {
			setEditorState((state) => ({
				...state,
				timeline: {
					...state.timeline,
					selection: { type: "clip", indices: [index] },
				},
			}));
		},
		[setEditorState],
	);

	const handleDeselectSegment = useCallback(() => {
		setEditorState((state) => ({
			...state,
			timeline: {
				...state.timeline,
				selection: null,
			},
		}));
	}, [setEditorState]);

	const handleTrimBegin = useCallback(() => {
		history.startBatch();
	}, [history]);

	const handleTrimStart = useCallback(
		(index: number, newStart: number) => {
			if (!project.timeline) return;
			const updatedSegments = project.timeline.segments.map((seg, i) =>
				i === index ? { ...seg, start: newStart } : seg,
			);
			setProjectWithoutHistory({
				...project,
				timeline: { ...project.timeline, segments: updatedSegments },
			});
		},
		[project, setProjectWithoutHistory],
	);

	const handleTrimEnd = useCallback(
		(index: number, newEnd: number) => {
			if (!project.timeline) return;
			const updatedSegments = project.timeline.segments.map((seg, i) =>
				i === index ? { ...seg, end: newEnd } : seg,
			);
			setProjectWithoutHistory({
				...project,
				timeline: { ...project.timeline, segments: updatedSegments },
			});
		},
		[project, setProjectWithoutHistory],
	);

	const handleTrimCommit = useCallback(() => {
		history.commitBatch();
	}, [history]);

	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const handleWheel = (e: WheelEvent) => {
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
		};

		container.addEventListener("wheel", handleWheel, { passive: false });
		return () => container.removeEventListener("wheel", handleWheel);
	}, [
		transform,
		duration,
		secsPerPixel,
		timelineBounds?.width,
		editorState.previewTime,
		editorState.playbackTime,
		setEditorState,
	]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		let initialDistance = 0;
		let initialZoom = transform.zoom;

		const getDistance = (t1: Touch, t2: Touch) =>
			Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);

		const handleTouchStart = (e: TouchEvent) => {
			if (e.touches.length === 2) {
				const touch1 = e.touches[0];
				const touch2 = e.touches[1];
				if (touch1 && touch2) {
					initialDistance = getDistance(touch1, touch2);
					initialZoom = transform.zoom;
				}
			}
		};

		const handleTouchMove = (e: TouchEvent) => {
			if (e.touches.length === 2) {
				e.preventDefault();
				const touch1 = e.touches[0];
				const touch2 = e.touches[1];
				if (!touch1 || !touch2 || initialDistance === 0) return;
				const currentDistance = getDistance(touch1, touch2);
				const scale = initialDistance / currentDistance;
				const newZoom = Math.max(1, Math.min(duration, initialZoom * scale));

				const midX =
					(touch1.clientX + touch2.clientX) / 2 - (timelineBounds?.left ?? 0);
				const ratio = timelineBounds?.width ? midX / timelineBounds.width : 0.5;
				const anchor = transform.position + ratio * transform.zoom;
				const newPosition = Math.max(
					0,
					Math.min(duration - newZoom, anchor - ratio * newZoom),
				);

				setEditorState((state) => ({
					...state,
					timeline: {
						...state.timeline,
						transform: { position: newPosition, zoom: newZoom },
					},
				}));
			}
		};

		container.addEventListener("touchstart", handleTouchStart, {
			passive: true,
		});
		container.addEventListener("touchmove", handleTouchMove, {
			passive: false,
		});

		return () => {
			container.removeEventListener("touchstart", handleTouchStart);
			container.removeEventListener("touchmove", handleTouchMove);
		};
	}, [transform, duration, timelineBounds, setEditorState]);

	const handlePointerMove = useCallback(
		(e: React.PointerEvent) => {
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
			transform.position,
			secsPerPixel,
			duration,
			timelineBounds,
			editorState.playing,
			setEditorState,
		],
	);

	const segments = project.timeline?.segments ?? [
		{ start: 0, end: duration, timescale: 1 },
	];

	return (
		<TimelineContextProvider duration={duration}>
			<div
				ref={containerRef}
				className="relative flex flex-col h-full bg-gray-2 border-t border-gray-4 overflow-hidden"
				style={{
					paddingLeft: TIMELINE_PADDING,
					paddingRight: TIMELINE_PADDING,
					touchAction: "pan-x",
				}}
				onPointerMove={handlePointerMove}
				onPointerLeave={() =>
					setEditorState((state) => ({ ...state, previewTime: 0 }))
				}
			>
				<div
					className="relative flex items-end cursor-pointer"
					style={{ height: TIMELINE_HEADER_HEIGHT, marginLeft: TRACK_GUTTER }}
					onClick={handleUpdatePlayhead}
				>
					<TimelineMarkings
						transform={transform}
						secsPerPixel={secsPerPixel}
						duration={duration}
					/>
				</div>

				<div className="relative flex-1 min-h-0">
					<Playhead
						trackGutter={TRACK_GUTTER}
						secsPerPixel={secsPerPixel}
						timelineWidth={timelineBounds?.width ?? null}
					/>

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
								selectedIndices={selection?.indices ?? []}
								onSelectSegment={handleSelectSegment}
								onDeselectSegment={handleDeselectSegment}
								onTrimBegin={handleTrimBegin}
								onTrimStart={handleTrimStart}
								onTrimEnd={handleTrimEnd}
								onTrimCommit={handleTrimCommit}
								waveformData={waveformData}
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
	const markingResolutions = [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600];
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
	selectedIndices: number[];
	onSelectSegment: (index: number) => void;
	onDeselectSegment: () => void;
	onTrimBegin: () => void;
	onTrimStart: (index: number, newStart: number) => void;
	onTrimEnd: (index: number, newEnd: number) => void;
	onTrimCommit: () => void;
	waveformData: WaveformData | null;
}

function ClipTrack({
	segments,
	transform,
	secsPerPixel,
	duration,
	selectedIndices,
	onSelectSegment,
	onDeselectSegment,
	onTrimBegin,
	onTrimStart,
	onTrimEnd,
	onTrimCommit,
	waveformData,
}: ClipTrackProps) {
	const visibleRange = {
		start: Math.max(0, transform.position - 2),
		end: Math.min(duration, transform.position + transform.zoom + 2),
	};

	const handleBackgroundClick = useCallback(
		(e: React.MouseEvent) => {
			if (e.target === e.currentTarget) {
				onDeselectSegment();
			}
		},
		[onDeselectSegment],
	);

	return (
		<div
			className="absolute inset-0 flex items-center"
			onClick={handleBackgroundClick}
		>
			{segments.map((segment, index) => {
				if (
					segment.end < visibleRange.start ||
					segment.start > visibleRange.end
				) {
					return null;
				}

				return (
					<ClipSegment
						key={index}
						segment={segment}
						index={index}
						transform={transform}
						secsPerPixel={secsPerPixel}
						duration={duration}
						isSelected={selectedIndices.includes(index)}
						onSelect={onSelectSegment}
						onTrimBegin={onTrimBegin}
						onTrimStart={onTrimStart}
						onTrimEnd={onTrimEnd}
						onTrimCommit={onTrimCommit}
						waveformData={waveformData}
					/>
				);
			})}
		</div>
	);
}

export { TimelineContextProvider, useTimelineContext } from "./context";
export { Playhead } from "./Playhead";
