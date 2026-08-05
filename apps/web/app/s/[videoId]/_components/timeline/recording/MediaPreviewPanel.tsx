"use client";

import { useEffect, useMemo } from "react";
import { formatMediaDuration } from "../../media-comment/format-media-duration";
import { formatClock } from "../timeline-format";

/** Stop → look at it → send or retake. The blob loops muted until sent. */
export function MediaPreviewPanel({
	blob,
	durationSeconds,
	timestamp,
	onSend,
	onDiscard,
}: {
	blob: Blob;
	durationSeconds: number;
	timestamp: number;
	onSend: () => void;
	onDiscard: () => void;
}) {
	const previewUrl = useMemo(() => URL.createObjectURL(blob), [blob]);
	useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);

	return (
		<div className="new-card-style flex w-80 flex-col gap-2 p-2.5">
			<div className="relative aspect-video w-full overflow-hidden rounded-xl bg-gray-3">
				{/* biome-ignore lint/a11y/useMediaCaption: preview of the author's own recording */}
				<video
					src={previewUrl}
					autoPlay
					muted
					loop
					playsInline
					className="size-full object-contain"
				/>
				<span className="absolute right-1.5 bottom-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white">
					{formatMediaDuration(durationSeconds)}
				</span>
			</div>
			<div className="flex items-center gap-1.5">
				<span className="rounded-md bg-gray-2 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-gray-11 ring-1 ring-gray-4">
					{formatClock(timestamp)}
				</span>
				<div className="flex-1" />
				<button
					type="button"
					onClick={onDiscard}
					className="h-7 rounded-lg px-2.5 text-xs text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-12"
				>
					Retake
				</button>
				<button
					type="button"
					onClick={onSend}
					className="h-7 rounded-lg bg-blue-9 px-3.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
				>
					Send
				</button>
			</div>
		</div>
	);
}
