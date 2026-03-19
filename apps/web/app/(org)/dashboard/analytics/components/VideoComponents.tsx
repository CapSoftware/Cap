"use client";

import { faXmark } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { motion, useDragControls, useMotionValue } from "motion/react";
import React, { useEffect, useRef, useState } from "react";

export type VideoValue = string; // Can be video IDs in the future

interface DraggableVideoItemProps {
	videoId: string;
	isInUse: boolean;
	onDragStart: () => void;
	onDragEnd: (x: number, y: number) => void;
	onDrag: (x: number, y: number) => void;
}

export const DraggableVideoItem = ({
	videoId,
	isInUse,
	onDragStart,
	onDragEnd,
	onDrag,
}: DraggableVideoItemProps) => {
	const controls = useDragControls();
	const x = useMotionValue(0);
	const y = useMotionValue(0);
	const elementRef = useRef<HTMLDivElement>(null);

	const handleDragEnd = () => {
		if (elementRef.current) {
			const rect = elementRef.current.getBoundingClientRect();
			const centerX = rect.left + rect.width / 2;
			const centerY = rect.top + rect.height / 2;
			onDragEnd(centerX, centerY);
		}
	};

	const handleDrag = () => {
		if (elementRef.current) {
			const rect = elementRef.current.getBoundingClientRect();
			const centerX = rect.left + rect.width / 2;
			const centerY = rect.top + rect.height / 2;
			onDrag(centerX, centerY);
		}
	};

	if (isInUse) {
		return null;
	}

	return (
		<motion.div
			ref={elementRef}
			layoutId={`video-${videoId}`}
			drag
			dragControls={controls}
			dragSnapToOrigin
			onPointerDown={(e) => controls.start(e)}
			onDragStart={onDragStart}
			onDrag={handleDrag}
			style={{
				x,
				y,
				touchAction: "none",
			}}
			layout="position"
			initial={{ opacity: 0, scale: 0.9 }}
			animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
			exit={{ opacity: 0, scale: 0.9 }}
			transition={{
				layout: {
					type: "spring",
					stiffness: 600,
					damping: 35,
					mass: 0.8,
				},
				opacity: { duration: 0.15, ease: "easeInOut" },
				scale: { duration: 0.15, ease: "easeInOut" },
				x: { type: "spring", stiffness: 600, damping: 35 },
				y: { type: "spring", stiffness: 600, damping: 35 },
			}}
			onDragEnd={handleDragEnd}
			className="flex items-center justify-center w-full h-[64px] hover:bg-gray-5 hover:border-gray-7 transition-colors duration-200 rounded-lg bg-gray-4 border border-gray-6 cursor-grab active:cursor-grabbing"
		>
			<p className="text-xs text-gray-11">{videoId}</p>
		</motion.div>
	);
};

interface VideoDroppableProps {
	id: string;
	droppedValue: string | null;
	onRemove: () => void;
	isDragging: boolean;
	dragPosition: { x: number; y: number };
	label: string;
}

export const VideoDroppable = React.forwardRef<
	HTMLDivElement,
	VideoDroppableProps
>(({ droppedValue, onRemove, isDragging, dragPosition, label }, ref) => {
	const [isOver, setIsOver] = useState(false);

	useEffect(() => {
		if (!isDragging) {
			setIsOver(false);
			return;
		}

		const checkIsOver = () => {
			if (ref && typeof ref !== "function" && ref.current) {
				const rect = ref.current.getBoundingClientRect();
				const over =
					dragPosition.x >= rect.left &&
					dragPosition.x <= rect.right &&
					dragPosition.y >= rect.top &&
					dragPosition.y <= rect.bottom;
				setIsOver(over);
			}
		};

		checkIsOver();
	}, [isDragging, dragPosition, ref]);

	return (
		<div
			ref={ref}
			className={clsx(
				"flex flex-1 justify-center items-center h-20 rounded-xl border transition-all",
				isDragging && !isOver && !droppedValue
					? "bg-gray-5 border-solid border-gray-11"
					: isOver && isDragging
						? "bg-gray-4 border-blue-500 border-solid"
						: !droppedValue
							? "border-dashed border-gray-6 bg-gray-3"
							: "border-solid border-gray-5 bg-gray-3",
			)}
		>
			{droppedValue ? (
				<div className="flex gap-2 justify-between items-center p-3 w-full h-full">
					<p className="text-xs text-gray-11">{droppedValue}</p>
					<button
						type="button"
						onClick={onRemove}
						className="flex justify-center items-center rounded-full transition-colors cursor-pointer size-6 bg-gray-5 text-gray-11 hover:bg-gray-6 hover:text-gray-12"
						aria-label="Remove video"
					>
						<FontAwesomeIcon icon={faXmark} className="size-3" />
					</button>
				</div>
			) : (
				<p className="text-xs text-gray-11">{label}</p>
			)}
		</div>
	);
});

VideoDroppable.displayName = "VideoDroppable";
