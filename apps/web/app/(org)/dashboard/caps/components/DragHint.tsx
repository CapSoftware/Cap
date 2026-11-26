"use client";

import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import {
	CAP_DRAG_TYPE,
	FOLDER_DRAG_TYPE,
	parseCapDrag,
} from "@/lib/move-items";
import {
	FolderDoodle,
	libraryDoodleHost,
	MoveDoodle,
} from "../../_components/library-doodles";

type DragState = { kind: "caps"; count: number } | { kind: "folder" };

export function useLibraryDrag() {
	const [drag, setDrag] = useState<DragState | null>(null);

	useEffect(() => {
		const handleDragStart = (event: DragEvent) => {
			const transfer = event.dataTransfer;
			const types = transfer?.types ?? [];
			if (types.includes(FOLDER_DRAG_TYPE)) {
				setDrag({ kind: "folder" });
			} else if (types.includes(CAP_DRAG_TYPE)) {
				const payload = parseCapDrag(transfer?.getData(CAP_DRAG_TYPE) ?? "");
				setDrag({ kind: "caps", count: payload?.ids.length ?? 1 });
			} else {
				setDrag(null);
			}
		};
		const clear = () => setDrag(null);

		window.addEventListener("dragstart", handleDragStart);
		window.addEventListener("dragend", clear);
		// A drop can remove the dragged card before its dragend fires, and drop
		// targets stop the event from bubbling, so it is caught on the way down.
		window.addEventListener("drop", clear, true);

		return () => {
			window.removeEventListener("dragstart", handleDragStart);
			window.removeEventListener("dragend", clear);
			window.removeEventListener("drop", clear, true);
		};
	}, []);

	return drag;
}

const EDGE_ZONE = 72;
const MAX_STEP = 18;

function scrollParent(node: EventTarget | null) {
	let element = node instanceof Element ? node : null;
	while (element && element !== document.body) {
		const { overflowY } = getComputedStyle(element);
		if (
			(overflowY === "auto" || overflowY === "scroll") &&
			element.scrollHeight > element.clientHeight
		)
			return element;
		element = element.parentElement;
	}
	return document.scrollingElement;
}

// Browsers only scroll a nested container during a drag when the pointer is a
// few pixels from its edge, and some not at all, so long libraries scroll here
// while a Cap or folder is held near the top or bottom of the list.
function useDragAutoScroll(active: boolean) {
	useEffect(() => {
		if (!active) return;
		let pointer: { y: number; target: EventTarget | null } | null = null;
		let frame = 0;

		const tick = () => {
			frame = requestAnimationFrame(tick);
			if (!pointer) return;
			const container = scrollParent(pointer.target);
			if (!container) return;
			const rect =
				container === document.scrollingElement
					? { top: 0, bottom: window.innerHeight }
					: container.getBoundingClientRect();
			const fromTop = pointer.y - rect.top;
			const fromBottom = rect.bottom - pointer.y;
			const ease = (distance: number) =>
				MAX_STEP * (1 - Math.max(0, distance) / EDGE_ZONE) ** 2;
			if (fromTop < EDGE_ZONE) container.scrollTop -= ease(fromTop);
			else if (fromBottom < EDGE_ZONE) container.scrollTop += ease(fromBottom);
		};
		const track = (event: DragEvent) => {
			pointer = { y: event.clientY, target: event.target };
		};

		window.addEventListener("dragover", track, true);
		frame = requestAnimationFrame(tick);
		return () => {
			window.removeEventListener("dragover", track, true);
			cancelAnimationFrame(frame);
		};
	}, [active]);
}

export function DragHint({
	caps,
	folder = "Drop on another folder to move it inside",
}: {
	caps: string;
	folder?: string;
}) {
	const drag = useLibraryDrag();
	useDragAutoScroll(drag !== null);

	return (
		<div
			aria-live="polite"
			className="flex fixed inset-x-3 bottom-24 z-50 justify-center pointer-events-none sm:bottom-12"
		>
			<AnimatePresence>
				{drag && (
					<motion.div
						key="drag-hint"
						initial={{ opacity: 0, y: 8, scale: 0.97 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={{
							opacity: 0,
							y: 8,
							scale: 0.97,
							transition: { duration: 0.12 },
						}}
						transition={{ type: "spring", damping: 22, stiffness: 380 }}
						className={clsx(
							libraryDoodleHost,
							"flex gap-3 items-center py-2 pr-4 pl-2 max-w-full rounded-2xl border shadow-lg border-gray-4 bg-gray-1",
						)}
					>
						<span className="flex justify-center items-center rounded-xl size-9 shrink-0 bg-gray-3">
							{drag.kind === "folder" ? (
								<FolderDoodle size={24} />
							) : (
								<MoveDoodle size={24} />
							)}
						</span>
						<span className="flex flex-col min-w-0">
							<span className="text-sm font-medium truncate text-gray-12">
								{drag.kind === "folder"
									? "Moving a folder"
									: drag.count > 1
										? `Moving ${drag.count} Caps`
										: "Moving 1 Cap"}
							</span>
							<span className="text-xs truncate text-gray-10">
								{drag.kind === "folder" ? folder : caps}
							</span>
						</span>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
