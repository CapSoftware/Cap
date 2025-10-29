"use client";

import { faXmark } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { motion, useDragControls, useMotionValue } from "motion/react";
import React, { useEffect, useRef, useState } from "react";

const filterColorMap = {
	views: "bg-blue-300",
	comments: "bg-green-300",
	reactions: "bg-red-300",
	shares: "bg-yellow-300",
	downloads: "bg-purple-300",
	uploads: "bg-pink-300",
	deletions: "bg-gray-300",
	creations: "bg-orange-300",
	edits: "bg-teal-300",
} as const;

const labelMap = {
	views: "Views",
	comments: "Comments",
	reactions: "Reactions",
	shares: "Shares",
	downloads: "Downloads",
	uploads: "Uploads",
	deletions: "Deletions",
	creations: "Creations",
	edits: "Edits",
} as const;

export type FilterValue = keyof typeof filterColorMap;

interface CompareDataFilterItemProps {
	label: string;
	value: FilterValue;
	isInUse: boolean;
	onDragStart: () => void;
	onDragEnd: (x: number, y: number) => void;
	onDrag: (x: number, y: number) => void;
}

export const CompareDataFilterItem = ({
	label,
	value,
	isInUse,
	onDragStart,
	onDragEnd,
	onDrag,
}: CompareDataFilterItemProps) => {
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
			layoutId={`filter-${value}`}
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
			initial={{ opacity: 0, scale: 0.8 }}
			animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
			exit={{ opacity: 0, scale: 0.8 }}
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
			className={clsx(
				"flex-1 px-2 h-6 rounded-full cursor-grab active:cursor-grabbing max-w-fit min-w-fit",
				filterColorMap[value as keyof typeof filterColorMap] ?? "bg-gray-5",
			)}
		>
			<p className="text-[11px] font-medium text-black">{label}</p>
		</motion.div>
	);
};

interface CompareDataDroppableProps {
	id: string;
	droppedValue: string | null;
	onRemove: () => void;
	isDragging: boolean;
	dragPosition: { x: number; y: number };
}

export const CompareDataDroppable = React.forwardRef<
	HTMLDivElement,
	CompareDataDroppableProps
>(({ droppedValue, onRemove, isDragging, dragPosition }, ref) => {
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
				"h-6 w-[100px] transition-all border rounded-full file:flex items-center",
				isDragging && !isOver && !droppedValue
					? "bg-gray-5 border-gray-11"
					: isOver && isDragging
						? "bg-transparent border-blue-500"
						: !droppedValue
							? "border-dashed border-gray-7"
							: "border-transparent",
			)}
		>
			{droppedValue && (
				<div
					className={clsx(
						"flex items-center justify-between gap-1.5 px-2 h-6 rounded-full",
						filterColorMap[droppedValue as keyof typeof filterColorMap] ??
							"bg-gray-5",
					)}
				>
					<p className="text-[11px] font-medium text-black">
						{labelMap[droppedValue as keyof typeof labelMap] ?? droppedValue}
					</p>
					<button
						type="button"
						onClick={onRemove}
						className="flex justify-center items-center h-full text-black transition-colors cursor-pointer hover:text-gray-700"
						aria-label="Remove filter"
					>
						<FontAwesomeIcon icon={faXmark} className="text-black size-3" />
					</button>
				</div>
			)}
		</div>
	);
});
