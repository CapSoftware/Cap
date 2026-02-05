"use client";

import { useCallback, useMemo } from "react";
import { getPreviewLayoutStyles } from "../utils/preview-layout";
import { useEditorContext } from "./context";
import { PlayerControls } from "./PlayerControls";

export function Player() {
	const { videoUrl, videoRef, setEditorState, project, video } =
		useEditorContext();

	const previewLayout = useMemo(
		() =>
			getPreviewLayoutStyles(project, {
				width: video.width,
				height: video.height,
			}),
		[project, video.width, video.height],
	);

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
				<div className="w-full h-full flex items-center justify-center">
					<div
						className={`relative overflow-hidden flex items-center justify-center ${previewLayout.frameClassName}`}
						style={previewLayout.frameStyle}
						data-testid="editor-preview-frame"
					>
						<div
							className="flex items-center justify-center"
							style={previewLayout.contentStyle}
							data-testid="editor-preview-content"
						>
							<video
								ref={videoRef}
								src={videoUrl}
								className="w-full h-full object-contain"
								style={previewLayout.videoStyle}
								data-testid="editor-preview-video"
								onTimeUpdate={handleTimeUpdate}
								onEnded={handleEnded}
								onPlay={() =>
									setEditorState((state) => ({ ...state, playing: true }))
								}
								onPause={() =>
									setEditorState((state) => ({ ...state, playing: false }))
								}
								preload="metadata"
							>
								<track
									kind="captions"
									srcLang="en"
									label="English"
									src="data:text/vtt;charset=utf-8,WEBVTT%0A"
								/>
							</video>
						</div>
					</div>
				</div>
			</div>
			<PlayerControls />
		</div>
	);
}
