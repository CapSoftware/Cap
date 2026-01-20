"use client";

import { Button } from "@cap/ui";
import { Pause, Play, SkipBack } from "lucide-react";
import { formatTime } from "../utils/time";
import { useEditorContext } from "./context";

export function PlayerControls() {
	const { editorState, actions, video } = useEditorContext();

	return (
		<div className="flex items-center gap-4 px-4 py-3 border-t border-gray-4 bg-gray-2">
			<div className="flex items-center gap-2">
				<Button variant="ghost" size="sm" onClick={() => actions.seekTo(0)}>
					<SkipBack className="size-4" />
				</Button>

				<Button variant="ghost" size="sm" onClick={actions.togglePlayback}>
					{editorState.playing ? (
						<Pause className="size-4" />
					) : (
						<Play className="size-4" />
					)}
				</Button>
			</div>

			<div className="flex items-center gap-2 text-sm text-gray-11 font-mono">
				<span>{formatTime(editorState.playbackTime)}</span>
				<span>/</span>
				<span>{formatTime(video.duration)}</span>
			</div>
		</div>
	);
}
