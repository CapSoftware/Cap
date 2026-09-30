"use client";

import { Dialog, DialogContent, DialogTitle } from "@cap/ui";
import { useCallback, useEffect, useRef } from "react";
import {
	MediaPlayer,
	MediaPlayerControls,
	MediaPlayerControlsOverlay,
	MediaPlayerFullscreen,
	MediaPlayerPlay,
	MediaPlayerPlaybackSpeed,
	MediaPlayerSeek,
	MediaPlayerTime,
	MediaPlayerVideo,
	MediaPlayerVolume,
} from "../video/media-player";
import type { MediaComment } from "./media-comment-types";
import {
	claimPlayback,
	releasePlayback,
	suspendMainVideo,
} from "./media-playback-registry";

/**
 * The comment mini player: a video comment blown up into a dialog with the
 * share player's own controls — seek bar, time, volume, speed, fullscreen —
 * built from the same media-player primitives so the design is the player's,
 * just minified. Mounted only while open; the media-chrome store is per-mount,
 * so it never touches the main player's.
 */
export function CommentMiniPlayer({
	comment,
	src,
	onClose,
}: {
	comment: MediaComment;
	src: string;
	onClose: () => void;
}) {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const duration = comment.mediaDuration ?? undefined;

	const width = comment.mediaMeta?.width;
	const height = comment.mediaMeta?.height;
	const aspect =
		width && height && width > 0 && height > 0 ? width / height : 16 / 9;

	// The dialog joins the page-wide playback interlock like any other card:
	// opening pauses the main video (and any playing comment), closing hands
	// playback back if the main video was running.
	const attachVideo = useCallback((el: HTMLVideoElement | null) => {
		videoRef.current = el;
		if (!el) return;
		claimPlayback(el, () => el.pause());
		suspendMainVideo();
	}, []);

	const handleOpenChange = useCallback(
		(open: boolean) => {
			if (open) return;
			const el = videoRef.current;
			if (el) {
				el.pause();
				releasePlayback(el, { resumeMain: true });
			}
			onClose();
		},
		[onClose],
	);

	// The host card can unmount the whole dialog (list re-order, tab switch);
	// the interaction is over either way, so settle up like a close would.
	useEffect(
		() => () => {
			const el = videoRef.current;
			if (!el) return;
			el.pause();
			releasePlayback(el, { resumeMain: true });
		},
		[],
	);

	return (
		<Dialog open onOpenChange={handleOpenChange}>
			<DialogContent
				hideCloseButton
				aria-describedby={undefined}
				className="w-[calc(100vw-2rem)] max-w-3xl overflow-visible rounded-xl border-0 bg-transparent p-0 shadow-none"
			>
				<DialogTitle className="sr-only">Video comment</DialogTitle>
				<MediaPlayer
					autoHide
					label="Video comment"
					className="mx-auto max-h-[80vh] w-full rounded-xl bg-black shadow-2xl"
					style={{ aspectRatio: String(aspect) }}
				>
					<MediaPlayerVideo
						ref={attachVideo}
						src={src}
						autoPlay
						playsInline
						className="size-full"
					/>
					<button
						type="button"
						onClick={() => handleOpenChange(false)}
						aria-label="Close video comment"
						className="absolute top-2.5 right-2.5 z-20 grid size-7 place-items-center rounded-full bg-black/45 text-white backdrop-blur-md transition-colors hover:bg-black/65"
					>
						<svg
							width="11"
							height="11"
							viewBox="0 0 10 10"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							aria-hidden="true"
						>
							<path d="M1 1l8 8M9 1l-8 8" />
						</svg>
					</button>
					<MediaPlayerControls className="flex-col items-start gap-2">
						<MediaPlayerControlsOverlay className="rounded-b-xl" />
						<MediaPlayerSeek fallbackDuration={duration} />
						<div className="flex w-full items-center gap-2">
							<div className="flex flex-1 items-center gap-2">
								<MediaPlayerPlay />
								<MediaPlayerVolume expandable />
								<MediaPlayerTime fallbackDuration={duration} />
							</div>
							<div className="flex items-center gap-2">
								<MediaPlayerPlaybackSpeed />
								<MediaPlayerFullscreen />
							</div>
						</div>
					</MediaPlayerControls>
				</MediaPlayer>
			</DialogContent>
		</Dialog>
	);
}
