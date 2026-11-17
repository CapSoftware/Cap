"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import styles from "./EarlyUploadOverlay.module.css";
import { formatClock } from "./early-playback";

const FRAME_WIDTH = 48;

function useCountUp(value: number): number {
	const [shown, setShown] = useState(Math.floor(value));
	const currentRef = useRef(value);
	useEffect(() => {
		const start = currentRef.current;
		const delta = value - start;
		if (delta <= 0) {
			currentRef.current = value;
			setShown(Math.floor(value));
			return;
		}
		const began = performance.now();
		const duration = Math.min(1800, 400 + delta * 120);
		let frame = 0;
		const step = (now: number) => {
			const progress = Math.min(1, (now - began) / duration);
			const next = start + delta * (1 - (1 - progress) ** 3);
			currentRef.current = next;
			setShown(Math.floor(next));
			if (progress < 1) frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [value]);
	return shown;
}

// The paused frame is drawn once into a tiny canvas and scaled up, so the
// blur costs nothing per frame; the grain and sheen only move layers.
export function EarlyUploadOverlay({
	videoRef,
	target,
	ready,
	recorded,
	uploadComplete,
	stalled,
}: {
	videoRef: RefObject<HTMLVideoElement | null>;
	target: number | null;
	ready: number;
	recorded: number | null;
	uploadComplete: boolean;
	stalled: boolean;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const shown = useCountUp(ready);

	useEffect(() => {
		const video = videoRef.current;
		const canvas = canvasRef.current;
		if (!video || !canvas || video.readyState < 2) return;
		const height =
			video.videoWidth > 0
				? Math.max(
						1,
						Math.round((FRAME_WIDTH * video.videoHeight) / video.videoWidth),
					)
				: 27;
		canvas.width = FRAME_WIDTH;
		canvas.height = height;
		try {
			canvas.getContext("2d")?.drawImage(video, 0, 0, FRAME_WIDTH, height);
		} catch {}
	}, [videoRef]);

	// The server can be a playlist refresh ahead of the player, so a part it
	// already has is loading, not uploading.
	const waitingAt = target ?? videoRef.current?.currentTime ?? 0;
	const isLoading = uploadComplete || waitingAt + 1 <= ready;
	const title =
		target === null
			? isLoading
				? "Loading the rest"
				: "The rest is still uploading"
			: isLoading
				? `Loading ${formatClock(target)}`
				: `${formatClock(target)} is still uploading`;
	const total = recorded !== null && recorded > 0 ? recorded : null;
	const shownSeconds = total === null ? shown : Math.min(shown, total);

	return (
		<div className={styles.root} data-slot="early-upload-overlay">
			<canvas ref={canvasRef} className={styles.frame} aria-hidden />
			<div className={styles.tint} aria-hidden />
			<div className={styles.grain} aria-hidden />
			<div className={styles.sheen} aria-hidden />
			<div className={styles.content} role="status" aria-live="polite">
				<p className={styles.title}>{title}</p>
				<p className={styles.detail}>
					{total === null
						? `${formatClock(shownSeconds)} uploaded so far`
						: `${formatClock(shownSeconds)} of ${formatClock(total)} uploaded`}
				</p>
				{total !== null && (
					<div className={styles.bar} aria-hidden>
						<div
							className={styles.barFill}
							style={{
								transform: `scaleX(${Math.min(1, Math.max(0, ready / total))})`,
							}}
						/>
					</div>
				)}
				{stalled && (
					<p className={styles.hint}>
						Keep Cap open on the computer that recorded this so the rest can
						upload.
					</p>
				)}
			</div>
		</div>
	);
}
