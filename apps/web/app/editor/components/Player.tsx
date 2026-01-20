"use client";

import { useCallback } from "react";
import { useEditorContext } from "./context";
import { PlayerControls } from "./PlayerControls";

export function Player() {
	const { videoUrl, videoRef, setEditorState } = useEditorContext();

	const handleTimeUpdate = useCallback(() => {
		if (videoRef.current) {
			const currentTime = videoRef.current.currentTime;
			setEditorState((state) => ({
				...state,
				playbackTime: currentTime,
				previewTime: currentTime,
			}));
		}
	}, [setEditorState, videoRef]);

	const handleEnded = useCallback(() => {
		setEditorState((state) => ({ ...state, playing: false }));
	}, [setEditorState]);

	return (
		<div className="flex-1 flex flex-col bg-gray-1 min-h-0">
			<div className="flex-1 flex items-center justify-center p-4 min-h-0">
				<video
					ref={videoRef}
					src={videoUrl}
					className="max-w-full max-h-full rounded-lg shadow-lg object-contain"
					onTimeUpdate={handleTimeUpdate}
					onEnded={handleEnded}
					onPlay={() =>
						setEditorState((state) => ({ ...state, playing: true }))
					}
					onPause={() =>
						setEditorState((state) => ({ ...state, playing: false }))
					}
					preload="metadata"
				/>
			</div>
			<PlayerControls />
		</div>
	);
}
