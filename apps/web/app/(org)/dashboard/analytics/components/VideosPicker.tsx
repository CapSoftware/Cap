"use client";

import { faRightLeft } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type React from "react";
import { VideoDroppable } from "./VideoComponents";

interface VideosPickerProps {
	droppedVideos: {
		video1: string | null;
		video2: string | null;
	};
	onRemoveVideo: (slotId: "video1" | "video2") => void;
	isDragging: boolean;
	dragPosition: { x: number; y: number };
	video1Ref: React.RefObject<HTMLDivElement | null>;
	video2Ref: React.RefObject<HTMLDivElement | null>;
}

export default function VideosPicker({
	droppedVideos,
	onRemoveVideo,
	isDragging,
	dragPosition,
	video1Ref,
	video2Ref,
}: VideosPickerProps) {
	return (
		<div className="flex gap-4 items-center">
			{/* biome-ignore lint: Static ID for drop zone identification */}
			<VideoDroppable
				id="video1"
				ref={video1Ref}
				droppedValue={droppedVideos.video1}
				onRemove={() => onRemoveVideo("video1")}
				isDragging={isDragging}
				dragPosition={dragPosition}
				label="Video 1"
			/>
			<div className="flex justify-center items-center rounded-full size-8 bg-gray-12">
				<FontAwesomeIcon icon={faRightLeft} className="size-2.5 text-gray-1" />
			</div>
			{/* biome-ignore lint: Static ID for drop zone identification */}
			<VideoDroppable
				id="video2"
				ref={video2Ref}
				droppedValue={droppedVideos.video2}
				onRemove={() => onRemoveVideo("video2")}
				isDragging={isDragging}
				dragPosition={dragPosition}
				label="Video 2"
			/>
		</div>
	);
}
