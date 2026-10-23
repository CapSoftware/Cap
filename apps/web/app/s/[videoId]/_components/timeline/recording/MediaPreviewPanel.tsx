"use client";

import { useEffect, useState } from "react";
import {
	MediaPlayer,
	MediaPlayerControls,
	MediaPlayerControlsOverlay,
	MediaPlayerPlay,
	MediaPlayerPlaybackSpeed,
	MediaPlayerSeek,
	MediaPlayerTime,
	MediaPlayerVideo,
	MediaPlayerVolume,
} from "../../video/media-player";
import { formatClock } from "../timeline-format";

/**
 * Stop → review → send or retake. A real (mini) player, not a silent loop:
 * checking the take means scrubbing it and hearing it, so the preview gets
 * the share player's own seek/volume/speed controls, always visible (no
 * autoHide — a review surface shouldn't make you hunt for the bar).
 */
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
	// Created in an effect, not useMemo: the memo survives StrictMode's
	// mount→cleanup→remount cycle but the cleanup's revoke does not — the
	// remount kept a revoked URL and the preview rendered black (send still
	// worked; the upload uses the blob, not the URL).
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	useEffect(() => {
		const url = URL.createObjectURL(blob);
		setPreviewUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [blob]);

	return (
		<div className="new-card-style flex w-96 max-w-full flex-col gap-2 p-2.5">
			<div className="relative aspect-video w-full overflow-hidden rounded-xl bg-gray-3">
				{previewUrl && (
					<MediaPlayer
						label="Recording preview"
						className="size-full rounded-xl bg-black"
					>
						<MediaPlayerVideo
							src={previewUrl}
							autoPlay
							playsInline
							className="size-full object-contain"
						/>
						<MediaPlayerControls className="flex-col items-start gap-1.5">
							<MediaPlayerControlsOverlay className="rounded-b-xl" />
							<MediaPlayerSeek fallbackDuration={durationSeconds} />
							<div className="flex w-full items-center gap-1.5">
								<MediaPlayerPlay />
								<MediaPlayerVolume expandable />
								<MediaPlayerTime fallbackDuration={durationSeconds} />
								<div className="flex-1" />
								<MediaPlayerPlaybackSpeed />
							</div>
						</MediaPlayerControls>
					</MediaPlayer>
				)}
			</div>
			<div className="flex items-center gap-1.5">
				{timestamp > 0 && (
					<span className="rounded-md bg-gray-2 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-gray-11 ring-1 ring-gray-4">
						{formatClock(timestamp)}
					</span>
				)}
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
