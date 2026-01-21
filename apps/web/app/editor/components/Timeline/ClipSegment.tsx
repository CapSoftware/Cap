"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { TimelineSegment } from "../../types/project-config";
import { getPeaksInRange, type WaveformData } from "../../utils/waveform";
import { useEditorContext } from "../context";
import { SegmentContextProvider } from "./context";
import { WaveformCanvas } from "./WaveformCanvas";

interface ClipSegmentProps {
	segment: TimelineSegment;
	index: number;
	transform: { position: number; zoom: number };
	secsPerPixel: number;
	duration: number;
	isSelected?: boolean;
	onSelect?: (index: number) => void;
	onTrimStart?: (index: number, newStart: number) => void;
	onTrimEnd?: (index: number, newEnd: number) => void;
	onTrimCommit?: () => void;
	waveformData: WaveformData | null;
}

const MIN_SEGMENT_DURATION = 0.1;

const SEGMENT_HEIGHT = 40;

export function ClipSegment({
	segment,
	index,
	transform,
	secsPerPixel,
	duration,
	isSelected = false,
	onSelect,
	onTrimStart,
	onTrimEnd,
	onTrimCommit,
	waveformData,
}: ClipSegmentProps) {
	const { actions } = useEditorContext();
	const segmentRef = useRef<HTMLButtonElement>(null);
	const [isDragging, setIsDragging] = useState<"start" | "end" | null>(null);

	const startX = useMemo(
		() => (segment.start - transform.position) / secsPerPixel,
		[segment.start, transform.position, secsPerPixel],
	);

	const width = useMemo(
		() => (segment.end - segment.start) / secsPerPixel,
		[segment.start, segment.end, secsPerPixel],
	);

	const handleClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onSelect?.(index);
		},
		[index, onSelect],
	);

	const handleDoubleClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			actions.seekTo(segment.start);
		},
		[segment.start, actions],
	);

	const handleTrimMouseDown = useCallback(
		(e: React.MouseEvent, edge: "start" | "end") => {
			e.stopPropagation();
			e.preventDefault();
			setIsDragging(edge);

			const startClientX = e.clientX;
			const originalStart = segment.start;
			const originalEnd = segment.end;

			const handleMouseMove = (moveEvent: MouseEvent) => {
				const deltaX = moveEvent.clientX - startClientX;
				const deltaTime = deltaX * secsPerPixel;

				if (edge === "start") {
					const newStart = Math.max(
						0,
						Math.min(
							originalEnd - MIN_SEGMENT_DURATION,
							originalStart + deltaTime,
						),
					);
					onTrimStart?.(index, newStart);
				} else {
					const newEnd = Math.max(
						originalStart + MIN_SEGMENT_DURATION,
						Math.min(duration, originalEnd + deltaTime),
					);
					onTrimEnd?.(index, newEnd);
				}
			};

			const handleMouseUp = () => {
				setIsDragging(null);
				document.removeEventListener("mousemove", handleMouseMove);
				document.removeEventListener("mouseup", handleMouseUp);
				onTrimCommit?.();
			};

			document.addEventListener("mousemove", handleMouseMove);
			document.addEventListener("mouseup", handleMouseUp);
		},
		[
			segment.start,
			segment.end,
			secsPerPixel,
			index,
			onTrimStart,
			onTrimEnd,
			onTrimCommit,
			duration,
		],
	);

	const timescaleLabel = useMemo(() => {
		if (segment.timescale === 1) return null;
		return `${segment.timescale}x`;
	}, [segment.timescale]);

	const segmentPeaks = useMemo(() => {
		if (!waveformData || width <= 0) return null;
		const targetSamples = Math.max(1, Math.floor(width / 3));
		return getPeaksInRange(
			waveformData,
			segment.start,
			segment.end,
			targetSamples,
		);
	}, [waveformData, segment.start, segment.end, width]);

	return (
		<SegmentContextProvider width={width}>
			<button
				ref={segmentRef}
				type="button"
				className={`absolute h-full rounded-md transition-colors ${
					isSelected
						? "bg-blue-500/40 border-blue-400 border-2"
						: "bg-blue-500/30 border-blue-500/50 border"
				} ${isDragging ? "cursor-ew-resize" : "cursor-pointer"}`}
				style={{
					left: `${startX}px`,
					width: `${Math.max(width, 4)}px`,
				}}
				onClick={handleClick}
				onDoubleClick={handleDoubleClick}
			>
				<TrimHandle
					edge="start"
					isDragging={isDragging === "start"}
					onMouseDown={(e) => handleTrimMouseDown(e, "start")}
				/>

				<div className="absolute inset-0 overflow-hidden">
					{segmentPeaks && width > 0 && (
						<WaveformCanvas
							peaks={segmentPeaks}
							width={Math.max(width, 4)}
							height={SEGMENT_HEIGHT}
							color="rgba(147, 197, 253, 0.7)"
							barWidth={2}
							barGap={1}
							mirror
						/>
					)}
					{timescaleLabel && (
						<div className="absolute inset-0 flex items-center justify-center">
							<span className="text-xs text-blue-300 font-medium truncate px-2">
								{timescaleLabel}
							</span>
						</div>
					)}
				</div>

				<TrimHandle
					edge="end"
					isDragging={isDragging === "end"}
					onMouseDown={(e) => handleTrimMouseDown(e, "end")}
				/>
			</button>
		</SegmentContextProvider>
	);
}

interface TrimHandleProps {
	edge: "start" | "end";
	isDragging: boolean;
	onMouseDown: (e: React.MouseEvent) => void;
}

function TrimHandle({ edge, isDragging, onMouseDown }: TrimHandleProps) {
	return (
		<div
			aria-hidden="true"
			className={`absolute top-0 bottom-0 w-2 cursor-ew-resize group ${
				edge === "start" ? "left-0" : "right-0"
			}`}
			onMouseDown={onMouseDown}
		>
			<div
				className={`absolute top-1/2 -translate-y-1/2 h-6 w-1 rounded-full transition-colors ${isDragging ? "bg-blue-300" : "bg-blue-400/50 group-hover:bg-blue-300"} ${edge === "start" ? "left-1" : "right-1"}`}
			/>
		</div>
	);
}

export type { ClipSegmentProps };
