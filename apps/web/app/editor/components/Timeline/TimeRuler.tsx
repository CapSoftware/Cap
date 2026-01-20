"use client";

import { useMemo } from "react";
import { formatTime } from "../../utils/time";
import { MAX_TIMELINE_MARKINGS, useTimelineContext } from "./context";
import { useEditorContext } from "../context";

const MARKING_RESOLUTIONS = [0.5, 1, 2.5, 5, 10, 30];

interface TimeRulerProps {
	height?: number;
}

interface Marking {
	time: number;
	x: number;
	isMajor: boolean;
}

export function TimeRuler({ height = 24 }: TimeRulerProps) {
	const { editorState } = useEditorContext();
	const { duration, secsPerPixel } = useTimelineContext();
	const { position, zoom } = editorState.timeline.transform;

	const markingResolution = useMemo(() => {
		return (
			MARKING_RESOLUTIONS.find((r) => zoom / r <= MAX_TIMELINE_MARKINGS) ?? 30
		);
	}, [zoom]);

	const markings = useMemo(() => {
		const markingCount = Math.ceil(2 + (zoom + 5) / markingResolution);
		const markingOffset = position % markingResolution;
		const result: Marking[] = [];

		for (let i = 0; i < markingCount; i++) {
			const time = position - markingOffset + i * markingResolution;
			if (time > 0 && time <= duration) {
				result.push({
					time,
					x: (time - position) / secsPerPixel,
					isMajor: time % 1 === 0,
				});
			}
		}

		return result;
	}, [position, markingResolution, secsPerPixel, duration, zoom]);

	return (
		<div
			className="relative w-full text-xs text-gray-9 select-none"
			style={{ height }}
		>
			{markings.map((marking) => (
				<div
					key={marking.time}
					className="absolute bottom-0"
					style={{ transform: `translateX(${marking.x}px)` }}
				>
					<div
						className={`w-px bg-current ${marking.isMajor ? "h-2" : "h-1"}`}
					/>
					{marking.isMajor && (
						<div className="absolute bottom-3 -translate-x-1/2 whitespace-nowrap text-gray-10">
							{formatTime(marking.time)}
						</div>
					)}
				</div>
			))}
		</div>
	);
}

export type { TimeRulerProps };
