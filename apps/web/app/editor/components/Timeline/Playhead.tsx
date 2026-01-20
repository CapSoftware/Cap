"use client";

import { useMemo } from "react";
import { useEditorContext } from "../context";
import { useTimelineContext } from "./context";

interface PlayheadProps {
	trackGutter?: number;
}

export function Playhead({ trackGutter = 64 }: PlayheadProps) {
	const { editorState } = useEditorContext();
	const { secsPerPixel, timelineBounds } = useTimelineContext();
	const { position } = editorState.timeline.transform;

	const playheadX = useMemo(() => {
		if (!timelineBounds?.width) return 0;
		const x = (editorState.playbackTime - position) / secsPerPixel;
		return Math.max(0, Math.min(x, timelineBounds.width));
	}, [editorState.playbackTime, position, secsPerPixel, timelineBounds?.width]);

	const previewX = useMemo(() => {
		if (!timelineBounds?.width || editorState.playing) return null;
		const time = editorState.previewTime;
		if (time === null || time === undefined || time <= 0) return null;
		const x = (time - position) / secsPerPixel;
		if (x < 0 || x > timelineBounds.width) return null;
		return x;
	}, [
		editorState.previewTime,
		editorState.playing,
		position,
		secsPerPixel,
		timelineBounds?.width,
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
