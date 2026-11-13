"use client";

import clsx from "clsx";
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

export function DragHint({
	caps,
	folder = "Drop on another folder to move it inside",
}: {
	caps: string;
	folder?: string;
}) {
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

	if (!drag) return null;

	const title =
		drag.kind === "folder"
			? "Moving a folder"
			: drag.count > 1
				? `Moving ${drag.count} Caps`
				: "Moving 1 Cap";

	return (
		<div
			aria-live="polite"
			className={clsx(
				libraryDoodleHost,
				"flex fixed top-24 left-1/2 z-50 gap-3 items-center py-2 pr-4 pl-2 max-w-[calc(100vw-32px)] rounded-2xl border shadow-lg -translate-x-1/2 pointer-events-none border-gray-4 bg-gray-1",
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
					{title}
				</span>
				<span className="text-xs truncate text-gray-10">
					{drag.kind === "folder" ? folder : caps}
				</span>
			</span>
		</div>
	);
}
