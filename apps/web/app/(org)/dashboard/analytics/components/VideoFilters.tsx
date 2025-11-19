"use client";

import { AnimatePresence, motion } from "motion/react";
import { DraggableVideoItem } from "./VideoComponents";

interface VideoFiltersProps {
	videos: readonly string[];
	isVideoInUse: (videoId: string) => boolean;
	onVideoDragStart: (videoId: string) => void;
	onVideoDragEnd: (x: number, y: number) => void;
	onVideoDrag: (x: number, y: number) => void;
}

export default function VideoFilters({
	videos,
	isVideoInUse,
	onVideoDragStart,
	onVideoDragEnd,
	onVideoDrag,
}: VideoFiltersProps) {
	return (
		<div className="max-w-[160px] w-full border-l border-gray-4">
			<div className="border-b border-gray-4 bg-gray-3">
				<p className="px-4 py-2 text-xs font-medium text-gray-12 will-change-auto">
					Videos
				</p>
			</div>
			<motion.div layout className="grid grid-cols-2 gap-2 p-4 h-fit">
				<AnimatePresence mode="popLayout">
					{videos.map((videoId) => (
						<DraggableVideoItem
							key={videoId}
							videoId={videoId}
							isInUse={isVideoInUse(videoId)}
							onDragStart={() => onVideoDragStart(videoId)}
							onDragEnd={onVideoDragEnd}
							onDrag={onVideoDrag}
						/>
					))}
				</AnimatePresence>
			</motion.div>
		</div>
	);
}
