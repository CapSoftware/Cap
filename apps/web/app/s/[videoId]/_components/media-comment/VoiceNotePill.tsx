"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { commentMediaUrl } from "@/lib/comment-media";
import { formatMediaDuration } from "./format-media-duration";
import type { MediaComment } from "./media-comment-types";
import {
	claimPlayback,
	releasePlayback,
	suspendMainVideo,
} from "./media-playback-registry";
import { UploadProgressIndicator } from "./UploadProgressIndicator";
import {
	resolveWaveform,
	WAVEFORM_BAR_COUNT,
	WAVEFORM_BAR_COUNT_COMPACT,
	WaveformBars,
} from "./WaveformBars";

const PlayGlyph = () => (
	<svg
		width="10"
		height="12"
		viewBox="0 0 10 12"
		fill="currentColor"
		aria-hidden="true"
	>
		<path d="M0 1.14c0-.9.98-1.45 1.75-1L9.4 4.7a1.14 1.14 0 0 1 0 1.96L1.75 11.2A1.14 1.14 0 0 1 0 10.22V1.14Z" />
	</svg>
);

const PauseGlyph = () => (
	<svg
		width="10"
		height="12"
		viewBox="0 0 10 12"
		fill="currentColor"
		aria-hidden="true"
	>
		<rect x="0" y="0" width="3.4" height="12" rx="1" />
		<rect x="6.6" y="0" width="3.4" height="12" rx="1" />
	</svg>
);

interface VoiceNotePillProps {
	comment: MediaComment;
	localUrl?: string;
	compact?: boolean;
	className?: string;
}

/**
 * WhatsApp-style voice note: play circle, waveform with played-portion fill,
 * remaining-time label. Playback progress paints via `--p` + `textContent`
 * inside a rAF loop — no React renders while the note plays.
 */
export const VoiceNotePill = ({
	comment,
	localUrl,
	compact = false,
	className,
}: VoiceNotePillProps) => {
	const [playing, setPlaying] = useState(false);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const progressRef = useRef<HTMLElement | null>(null);
	const labelRef = useRef<HTMLSpanElement | null>(null);
	const rafRef = useRef(0);

	const barCount = compact ? WAVEFORM_BAR_COUNT_COMPACT : WAVEFORM_BAR_COUNT;
	const peaks = resolveWaveform(
		comment.id,
		comment.mediaMeta?.waveform ?? null,
		barCount,
	);

	const durationOf = useCallback(() => {
		const el = audioRef.current;
		const metaDuration = el?.duration;
		if (metaDuration && Number.isFinite(metaDuration)) return metaDuration;
		return comment.mediaDuration ?? 0;
	}, [comment.mediaDuration]);

	const paint = useCallback(() => {
		const el = audioRef.current;
		if (!el) return;
		const duration = durationOf();
		const fraction = duration > 0 ? el.currentTime / duration : 0;
		progressRef.current?.style.setProperty(
			"--p",
			`${Math.min(100, fraction * 100)}%`,
		);
		if (labelRef.current) {
			const remaining = Math.max(0, duration - el.currentTime);
			const text = formatMediaDuration(remaining);
			if (labelRef.current.textContent !== text)
				labelRef.current.textContent = text;
		}
	}, [durationOf]);

	const stopPainting = useCallback(
		() => cancelAnimationFrame(rafRef.current),
		[],
	);

	const paintLoop = useCallback(() => {
		paint();
		rafRef.current = requestAnimationFrame(paintLoop);
	}, [paint]);

	// The registry's stop: a plain pause that keeps position, so a different
	// card taking over doesn't lose the listener's place in this note.
	const handleRegistryStop = useCallback(() => {
		audioRef.current?.pause();
		stopPainting();
		setPlaying(false);
	}, [stopPainting]);

	const ensureAudio = useCallback(() => {
		if (audioRef.current) return audioRef.current;
		const el = new Audio(
			localUrl ??
				(comment.mediaKey
					? commentMediaUrl(comment.videoId, comment.mediaKey)
					: ""),
		);
		el.preload = "metadata";
		el.addEventListener("ended", () => {
			stopPainting();
			setPlaying(false);
			el.currentTime = 0;
			progressRef.current?.style.setProperty("--p", "0%");
			if (labelRef.current)
				labelRef.current.textContent = formatMediaDuration(durationOf());
			releasePlayback(el, { resumeMain: true });
		});
		audioRef.current = el;
		return el;
	}, [comment.mediaKey, comment.videoId, durationOf, localUrl, stopPainting]);

	const toggle = useCallback(() => {
		const el = ensureAudio();
		if (playing) {
			// User pause keeps the claim: mid-note is still "their turn", the main
			// video should not snap back.
			el.pause();
			stopPainting();
			setPlaying(false);
			return;
		}
		claimPlayback(el, handleRegistryStop);
		suspendMainVideo();
		void el.play();
		setPlaying(true);
		paintLoop();
	}, [ensureAudio, handleRegistryStop, paintLoop, playing, stopPainting]);

	const seek = useCallback(
		(fraction: number) => {
			const el = ensureAudio();
			const duration = durationOf();
			if (duration <= 0) return;
			el.currentTime = fraction * duration;
			paint();
		},
		[durationOf, ensureAudio, paint],
	);

	useEffect(
		() => () => {
			stopPainting();
			const el = audioRef.current;
			if (!el) return;
			el.pause();
			el.src = "";
			// Unmount ends the interaction outright, so the main video gets its
			// resume if it was owed one.
			releasePlayback(el, { resumeMain: true });
		},
		[stopPainting],
	);

	return (
		<div
			className={`inline-flex h-9 max-w-full items-center gap-2.5 rounded-full bg-gray-2 pl-1 pr-3 ring-1 ring-gray-4 ${className ?? ""}`}
		>
			<button
				type="button"
				onClick={toggle}
				aria-label={playing ? "Pause voice note" : "Play voice note"}
				className="grid text-white rounded-full shrink-0 size-7 place-items-center bg-gray-12"
			>
				<AnimatePresence mode="wait" initial={false}>
					<motion.span
						key={playing ? "pause" : "play"}
						initial={{ scale: 0.8, opacity: 0 }}
						animate={{ scale: 1, opacity: 1 }}
						exit={{ scale: 0.8, opacity: 0 }}
						transition={{ duration: 0.14 }}
						className={playing ? "" : "translate-x-px"}
					>
						{playing ? <PauseGlyph /> : <PlayGlyph />}
					</motion.span>
				</AnimatePresence>
			</button>
			<WaveformBars peaks={peaks} progressRef={progressRef} onSeek={seek} />
			<UploadProgressIndicator commentId={comment.id} variant="inline" />
			<span
				ref={labelRef}
				className="text-[11px] shrink-0 tabular-nums text-gray-10"
			>
				{formatMediaDuration(comment.mediaDuration)}
			</span>
		</div>
	);
};
