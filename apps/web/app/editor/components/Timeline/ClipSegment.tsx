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
	displayStart: number;
	transform: { position: number; zoom: number };
	secsPerPixel: number;
	duration: number;
	isSelected?: boolean;
	onSelect?: (index: number) => void;
	onTrimBegin?: () => void;
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
	displayStart,
	transform,
	secsPerPixel,
	duration,
	isSelected = false,
	onSelect,
	onTrimBegin,
	onTrimStart,
	onTrimEnd,
	onTrimCommit,
	waveformData,
}: ClipSegmentProps) {
	const { actions } = useEditorContext();
	const segmentRef = useRef<HTMLButtonElement>(null);
	const [isDragging, setIsDragging] = useState<"start" | "end" | null>(null);
	const effectiveTimescale = segment.timescale > 0 ? segment.timescale : 1;

	const startX = useMemo(
		() => (displayStart - transform.position) / secsPerPixel,
		[displayStart, transform.position, secsPerPixel],
	);

	const width = useMemo(
		() => (segment.end - segment.start) / effectiveTimescale / secsPerPixel,
		[segment.start, segment.end, effectiveTimescale, secsPerPixel],
	);

	const handleClick = useCallback(() => {
		onSelect?.(index);
	}, [index, onSelect]);

	const handleDoubleClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			actions.seekTo(segment.start);
		},
		[segment.start, actions],
	);

	const handleTrimPointerDown = useCallback(
		(e: React.PointerEvent, edge: "start" | "end") => {
			e.stopPropagation();
			e.preventDefault();
			e.currentTarget.setPointerCapture(e.pointerId);
			onSelect?.(index);
			onTrimBegin?.();
			setIsDragging(edge);

			const startClientX = e.clientX;
			const originalStart = segment.start;
			const originalEnd = segment.end;

			const handlePointerMove = (moveEvent: PointerEvent) => {
				const deltaX = moveEvent.clientX - startClientX;
				const deltaSourceTime = deltaX * secsPerPixel * effectiveTimescale;

				if (edge === "start") {
					const newStart = Math.max(
						0,
						Math.min(
							originalEnd - MIN_SEGMENT_DURATION,
							originalStart + deltaSourceTime,
						),
					);
					onTrimStart?.(index, newStart);
				} else {
					const newEnd = Math.max(
						originalStart + MIN_SEGMENT_DURATION,
						Math.min(duration, originalEnd + deltaSourceTime),
					);
					onTrimEnd?.(index, newEnd);
				}
			};

			const handlePointerUp = () => {
				setIsDragging(null);
				document.removeEventListener("pointermove", handlePointerMove);
				document.removeEventListener("pointerup", handlePointerUp);
				onTrimCommit?.();
			};

			document.addEventListener("pointermove", handlePointerMove);
			document.addEventListener("pointerup", handlePointerUp);
		},
		[
			segment.start,
			segment.end,
			secsPerPixel,
			effectiveTimescale,
			index,
			onTrimBegin,
			onTrimStart,
			onTrimEnd,
			onTrimCommit,
			onSelect,
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
				className={`absolute h-full rounded-md transition-colors overflow-visible ${
					isSelected
						? "bg-blue-500/40 border-blue-400 border-2 z-20"
						: "bg-blue-500/30 border-blue-500/50 border z-10"
				} ${isDragging ? "cursor-ew-resize" : "cursor-pointer"}`}
				style={{
					left: `${startX}px`,
					width: `${Math.max(width, 12)}px`,
				}}
				onClick={handleClick}
				onDoubleClick={handleDoubleClick}
			>
				<TrimHandle
					edge="start"
					isDragging={isDragging === "start"}
					onPointerDown={(e) => handleTrimPointerDown(e, "start")}
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
					onPointerDown={(e) => handleTrimPointerDown(e, "end")}
				/>
			</button>
		</SegmentContextProvider>
	);
}

interface TrimHandleProps {
	edge: "start" | "end";
	isDragging: boolean;
	onPointerDown: (e: React.PointerEvent) => void;
}

function TrimHandle({ edge, isDragging, onPointerDown }: TrimHandleProps) {
	return (
		<div
			aria-hidden="true"
			className={`absolute top-0 bottom-0 w-4 cursor-ew-resize group z-30 ${
				edge === "start" ? "-left-2" : "-right-2"
			}`}
			style={{ touchAction: "none" }}
			onPointerDown={onPointerDown}
		>
			<div
				className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-6 w-1 rounded-full transition-colors ${isDragging ? "bg-blue-300" : "bg-blue-400/50 group-hover:bg-blue-300"}`}
			/>
		</div>
	);
}

export type { ClipSegmentProps };
