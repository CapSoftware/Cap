"use client";

import { Button } from "@cap/ui";
import { Pause, Play, Scissors, SkipBack } from "lucide-react";
import { useCallback } from "react";
import { splitSegmentAtSourceTime } from "../utils/timeline";
import { useEditorContext } from "./context";

function formatPlaybackTime(seconds: number): string {
	const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
	const totalCentiseconds = Math.floor(safeSeconds * 100);
	const hours = Math.floor(totalCentiseconds / 360000);
	const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
	const secs = Math.floor((totalCentiseconds % 6000) / 100);
	const centiseconds = totalCentiseconds % 100;

	if (hours > 0) {
		return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
			.toString()
			.padStart(2, "0")}:${centiseconds.toString().padStart(2, "0")}`;
	}

	return `${minutes}:${secs.toString().padStart(2, "0")}:${centiseconds
		.toString()
		.padStart(2, "0")}`;
}

export function PlayerControls() {
	const { editorState, actions, video, project, setProject, setEditorState } =
		useEditorContext();

	const handleSplit = useCallback(() => {
		if (!project.timeline) return;

		const result = splitSegmentAtSourceTime(
			project.timeline.segments,
			editorState.playbackTime,
		);
		if (!result) return;

		setProject({
			...project,
			timeline: {
				...project.timeline,
				segments: result.segments,
			},
		});

		setEditorState((state) => ({
			...state,
			timeline: {
				...state.timeline,
				selection: { type: "clip", indices: [result.selectionIndex] },
			},
		}));
	}, [editorState.playbackTime, project, setProject, setEditorState]);

	const canSplit =
		project.timeline?.segments && project.timeline.segments.length > 0;

	return (
		<div className="flex items-center gap-4 px-4 py-3 border-t border-gray-4 bg-gray-2">
			<div className="flex items-center gap-2">
				<Button
					variant="ghost"
					size="sm"
					onClick={() => actions.seekTo(0)}
					className="text-gray-11 hover:text-gray-12 hover:bg-gray-4"
				>
					<SkipBack className="size-4" />
				</Button>

				<Button
					variant="ghost"
					size="sm"
					onClick={actions.togglePlayback}
					className="text-gray-11 hover:text-gray-12 hover:bg-gray-4"
				>
					{editorState.playing ? (
						<Pause className="size-4" />
					) : (
						<Play className="size-4" />
					)}
				</Button>

				<Button
					variant="ghost"
					size="sm"
					onClick={handleSplit}
					disabled={!canSplit}
					title="Split at playhead (S/C)"
					className="text-gray-11 hover:text-gray-12 hover:bg-gray-4"
				>
					<Scissors className="size-4" />
				</Button>
			</div>

			<div className="flex items-center gap-2 text-sm text-gray-11 font-mono">
				<span>{formatPlaybackTime(editorState.playbackTime)}</span>
				<span>/</span>
				<span>{formatPlaybackTime(video.duration)}</span>
			</div>
		</div>
	);
}
