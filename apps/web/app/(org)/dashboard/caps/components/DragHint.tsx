"use client";

import { useEffect, useState } from "react";
import { CAP_DRAG_TYPE, FOLDER_DRAG_TYPE } from "@/lib/move-items";

type DragKind = "caps" | "folder";

export function DragHint({
	caps,
	folder = "Drop on another folder to move it inside",
}: {
	caps: string;
	folder?: string;
}) {
	const [kind, setKind] = useState<DragKind | null>(null);

	useEffect(() => {
		const handleDragStart = (event: DragEvent) => {
			const types = event.dataTransfer?.types ?? [];
			setKind(
				types.includes(FOLDER_DRAG_TYPE)
					? "folder"
					: types.includes(CAP_DRAG_TYPE)
						? "caps"
						: null,
			);
		};
		const clear = () => setKind(null);

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

	if (!kind) return null;

	return (
		<div
			aria-live="polite"
			className="flex fixed top-4 left-1/2 z-50 gap-2 items-center px-4 py-2 max-w-[calc(100vw-32px)] text-sm font-medium rounded-full shadow-lg -translate-x-1/2 pointer-events-none text-gray-1 bg-gray-12"
		>
			<span className="truncate">{kind === "folder" ? folder : caps}</span>
		</div>
	);
}
