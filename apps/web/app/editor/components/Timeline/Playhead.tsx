"use client";

import { useMemo } from "react";
import { useEditorContext } from "../context";

interface PlayheadProps {
	trackGutter?: number;
	secsPerPixel: number;
	timelineWidth: number | null;
}

export function Playhead({
	trackGutter = 64,
	secsPerPixel,
	timelineWidth,
}: PlayheadProps) {
	const { editorState } = useEditorContext();
	const { position } = editorState.timeline.transform;

	const playheadX = useMemo(() => {
		if (!timelineWidth) return 0;
		const x = (editorState.playbackTime - position) / secsPerPixel;
		return Math.max(0, Math.min(x, timelineWidth));
	}, [editorState.playbackTime, position, secsPerPixel, timelineWidth]);

	const previewX = useMemo(() => {
		if (!timelineWidth || editorState.playing) return null;
		const time = editorState.previewTime;
		if (time === null || time === undefined || time <= 0) return null;
		const x = (time - position) / secsPerPixel;
		if (x < 0 || x > timelineWidth) return null;
		return x;
	}, [
		editorState.previewTime,
		editorState.playing,
		position,
		secsPerPixel,
		timelineWidth,
	]);

	return (
		<>
			{previewX !== null && (
				<div
					className="absolute top-0 bottom-0 w-px bg-gray-8 pointer-events-none z-10"
					style={{
						left: trackGutter,
						transform: `translateX(${previewX}px)`,
					}}
				>
					<div className="absolute -top-2 left-1/2 -translate-x-1/2 size-3 rounded-full bg-gray-8" />
				</div>
			)}

			<div
				className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none z-20"
				style={{
					left: trackGutter,
					transform: `translateX(${playheadX}px)`,
				}}
			>
				<div className="absolute -top-2 left-1/2 -translate-x-1/2 size-3 rounded-full bg-red-500" />
			</div>
		</>
	);
}

export type { PlayheadProps };
