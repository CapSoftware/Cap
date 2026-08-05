"use client";

import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { commentMediaUrl } from "@/lib/comment-media";
import { formatMediaDuration } from "./format-media-duration";
import type { MediaComment } from "./media-comment-types";
import {
	claimPlayback,
	releasePlayback,
	suspendMainVideo,
} from "./media-playback-registry";

const FilmGlyph = () => (
	<svg
		width="20"
		height="20"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.5"
		aria-hidden="true"
	>
		<rect x="3" y="5" width="18" height="14" rx="2" />
		<path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4" />
	</svg>
);

interface VideoCommentCardProps {
	comment: MediaComment;
	localUrl?: string;
	className?: string;
}

/**
 * Video comment: poster with a play circle, swapping to an inline `<video>` on
 * first play. The element is never rendered until then — a sidebar can hold
 * dozens of these. Progress paints via a rAF `scaleX` write, zero renders.
 */
export const VideoCommentCard = ({
	comment,
	localUrl,
	className,
}: VideoCommentCardProps) => {
	const [playing, setPlaying] = useState(false);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const progressRef = useRef<HTMLDivElement | null>(null);
	const labelRef = useRef<HTMLSpanElement | null>(null);
	const rafRef = useRef(0);

	const src =
		localUrl ??
		(comment.mediaKey
			? commentMediaUrl(comment.videoId, comment.mediaKey)
			: undefined);
	const thumbnailKey = comment.mediaMeta?.thumbnailKey;
	const posterUrl = thumbnailKey
		? commentMediaUrl(comment.videoId, thumbnailKey)
		: null;

	const stopPainting = useCallback(
		() => cancelAnimationFrame(rafRef.current),
		[],
	);

	const paintLoop = useCallback(() => {
		const el = videoRef.current;
		if (el) {
			const duration = Number.isFinite(el.duration)
				? el.duration
				: (comment.mediaDuration ?? 0);
			const fraction = duration > 0 ? el.currentTime / duration : 0;
			if (progressRef.current)
				progressRef.current.style.transform = `scaleX(${Math.min(1, fraction)})`;
			if (labelRef.current) {
				const text = formatMediaDuration(
					Math.max(0, duration - el.currentTime),
				);
				if (labelRef.current.textContent !== text)
					labelRef.current.textContent = text;
			}
		}
		rafRef.current = requestAnimationFrame(paintLoop);
	}, [comment.mediaDuration]);

	// Registry stop collapses the card back to its poster (spec: a video card
	// losing the slot doesn't linger as a paused frame).
	const collapse = useCallback(() => {
		videoRef.current?.pause();
		stopPainting();
		setPlaying(false);
	}, [stopPainting]);

	const close = useCallback(() => {
		const el = videoRef.current;
		collapse();
		if (el) releasePlayback(el, { resumeMain: true });
	}, [collapse]);

	// The <video> mounts only after the play click, so claiming happens via ref
	// callback rather than an effect racing autoPlay.
	const attachVideo = useCallback(
		(el: HTMLVideoElement | null) => {
			videoRef.current = el;
			if (!el) return;
			claimPlayback(el, collapse);
			suspendMainVideo();
			el.addEventListener("ended", () => {
				collapse();
				releasePlayback(el, { resumeMain: true });
			});
			paintLoop();
		},
		[collapse, paintLoop],
	);

	useEffect(
		() => () => {
			stopPainting();
			const el = videoRef.current;
			if (!el) return;
			el.pause();
			releasePlayback(el, { resumeMain: true });
		},
		[stopPainting],
	);

	const togglePause = useCallback(() => {
		const el = videoRef.current;
		if (!el) return;
		if (el.paused) void el.play();
		else el.pause();
	}, []);

	if (!src) return null;

	return (
		<div
			className={`relative w-44 max-w-full overflow-hidden rounded-xl bg-gray-3 ring-1 ring-gray-5 aspect-video ${className ?? ""}`}
		>
			{playing ? (
				<>
					{/* biome-ignore lint/a11y/useMediaCaption: user-generated media comment */}
					<video
						ref={attachVideo}
						src={src}
						autoPlay
						playsInline
						onClick={togglePause}
						className="object-cover size-full cursor-pointer"
					/>
					<button
						type="button"
						onClick={close}
						aria-label="Close video comment"
						className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full bg-black/45 text-white backdrop-blur-md"
					>
						<svg
							width="10"
							height="10"
							viewBox="0 0 10 10"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							aria-hidden="true"
						>
							<path d="M1 1l8 8M9 1l-8 8" />
						</svg>
					</button>
					<span
						ref={labelRef}
						className="absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white"
					/>
					<div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/40">
						<div
							ref={progressRef}
							className="h-full bg-white origin-left"
							style={{ transform: "scaleX(0)" }}
						/>
					</div>
				</>
			) : (
				<motion.button
					type="button"
					onClick={() => setPlaying(true)}
					aria-label={`Play video comment (${formatMediaDuration(comment.mediaDuration)})`}
					whileHover={{ scale: 1.02 }}
					whileTap={{ scale: 0.985 }}
					className="relative block size-full"
				>
					{posterUrl ? (
						// biome-ignore lint/performance/noImgElement: signed 302 URL, next/image adds nothing
						<img
							src={posterUrl}
							alt=""
							className="object-cover size-full"
							loading="lazy"
						/>
					) : localUrl ? (
						// Optimistic cards have no uploaded thumbnail yet; the blob's own
						// first frame stands in via preload="metadata".
						<video
							src={localUrl}
							preload="metadata"
							muted
							playsInline
							className="object-cover size-full pointer-events-none"
						/>
					) : (
						<div className="grid size-full place-items-center bg-gradient-to-br from-gray-3 to-gray-5 text-gray-8">
							<FilmGlyph />
						</div>
					)}
					<span className="absolute inset-0 grid place-items-center">
						<span className="grid size-9 place-items-center rounded-full bg-black/45 text-white backdrop-blur-md">
							<svg
								width="12"
								height="14"
								viewBox="0 0 10 12"
								fill="currentColor"
								className="translate-x-px"
								aria-hidden="true"
							>
								<path d="M0 1.14c0-.9.98-1.45 1.75-1L9.4 4.7a1.14 1.14 0 0 1 0 1.96L1.75 11.2A1.14 1.14 0 0 1 0 10.22V1.14Z" />
							</svg>
						</span>
					</span>
					<span className="absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white">
						{formatMediaDuration(comment.mediaDuration)}
					</span>
				</motion.button>
			)}
		</div>
	);
};
