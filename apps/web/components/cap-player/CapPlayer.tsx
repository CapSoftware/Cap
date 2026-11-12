"use client";

import {
	type CSSProperties,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import styles from "./player.module.css";
import { attachSource, type CapPlayerSource } from "./source";

export interface CapPlayerProps {
	source: CapPlayerSource;
	title: string;
	poster?: string;
	aspectRatio?: string;
	autoPlay?: boolean;
	focusOnMount?: boolean;
	className?: string;
	onFirstPlay?: () => void;
	onEnded?: () => void;
}

const IDLE_AFTER_MS = 2200;
const SEEK_STEP_SECONDS = 5;

const clock = (seconds: number) => {
	const whole = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(whole / 60);
	return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
};

const resolutionLabel = (width: number) => {
	if (width >= 3840) return "4K";
	if (width >= 2560) return "1440p";
	if (width >= 1920) return "1080p";
	if (width >= 1280) return "720p";
	return width > 0 ? "360p" : "";
};

type FullscreenVideo = HTMLVideoElement & {
	webkitEnterFullscreen?: () => void;
};

const PlayIcon = () => (
	<svg viewBox="0 0 16 16" aria-hidden="true">
		<path d="M4.5 2.6v10.8a.6.6 0 0 0 .92.5l8.3-5.4a.6.6 0 0 0 0-1L5.42 2.1a.6.6 0 0 0-.92.5Z" />
	</svg>
);

const PauseIcon = () => (
	<svg viewBox="0 0 16 16" aria-hidden="true">
		<rect x="3.5" y="2.5" width="3.2" height="11" rx="0.8" />
		<rect x="9.3" y="2.5" width="3.2" height="11" rx="0.8" />
	</svg>
);

const VolumeIcon = ({ muted }: { muted: boolean }) => (
	<svg viewBox="0 0 16 16" aria-hidden="true">
		<path d="M7.6 2.7 4.4 5.4H2.6a.6.6 0 0 0-.6.6v4a.6.6 0 0 0 .6.6h1.8l3.2 2.7a.5.5 0 0 0 .8-.4V3.1a.5.5 0 0 0-.8-.4Z" />
		{muted ? (
			<path
				d="m10.6 6.2 3.6 3.6m0-3.6-3.6 3.6"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.3"
				strokeLinecap="round"
			/>
		) : (
			<path
				d="M10.6 5.6a3.4 3.4 0 0 1 0 4.8m1.7-6.5a5.8 5.8 0 0 1 0 8.2"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.3"
				strokeLinecap="round"
			/>
		)}
	</svg>
);

const FullscreenIcon = ({ active }: { active: boolean }) => (
	<svg viewBox="0 0 16 16" aria-hidden="true">
		<path
			d={
				active
					? "M6 2.5V6H2.5M10 2.5V6h3.5M6 13.5V10H2.5m7.5 3.5V10h3.5"
					: "M2.5 6V2.5H6m4 0h3.5V6m0 4v3.5H10m-4 0H2.5V10"
			}
			fill="none"
			stroke="currentColor"
			strokeWidth="1.3"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

export const CapPlayer = ({
	source,
	title,
	poster,
	aspectRatio = "16 / 9",
	autoPlay = false,
	focusOnMount = false,
	className,
	onFirstPlay,
	onEnded,
}: CapPlayerProps) => {
	const rootRef = useRef<HTMLDivElement>(null);
	const videoRef = useRef<HTMLVideoElement>(null);
	const trackRef = useRef<HTMLDivElement>(null);
	const playedRef = useRef<HTMLDivElement>(null);
	const bufferedRef = useRef<HTMLDivElement>(null);
	const timeRef = useRef<HTMLSpanElement>(null);
	const qualityRef = useRef<HTMLSpanElement>(null);
	const callbacks = useRef({ onFirstPlay, onEnded });
	callbacks.current = { onFirstPlay, onEnded };

	const [playing, setPlaying] = useState(false);
	const [muted, setMuted] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const [failed, setFailed] = useState(false);

	const { hls, mp4 } = source;

	useLayoutEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		setFailed(false);
		return attachSource(
			video,
			{ hls, mp4 },
			{ autoPlay, onFatal: () => setFailed(true) },
		);
	}, [hls, mp4, autoPlay]);

	useLayoutEffect(() => {
		if (!focusOnMount) return;
		rootRef.current
			?.querySelector<HTMLButtonElement>("button")
			?.focus({ preventScroll: true });
	}, [focusOnMount]);

	useEffect(() => {
		const root = rootRef.current;
		const video = videoRef.current;
		const track = trackRef.current;
		if (!root || !video || !track) return;

		let frame = 0;
		let idleTimer = 0;
		let waitTimer = 0;
		let shownText = "";
		let scrubbing = false;
		let resumeAfterScrub = false;
		let started = false;

		const duration = () =>
			Number.isFinite(video.duration) ? video.duration : 0;

		const paint = () => {
			const total = duration();
			const now = video.currentTime;
			const played = total > 0 ? Math.min(1, now / total) : 0;
			if (playedRef.current) {
				playedRef.current.style.transform = `scaleX(${played})`;
			}
			let ahead = 0;
			for (let i = 0; i < video.buffered.length; i++) {
				if (video.buffered.start(i) <= now + 0.25) {
					ahead = Math.max(ahead, video.buffered.end(i));
				}
			}
			if (bufferedRef.current) {
				bufferedRef.current.style.transform = `scaleX(${
					total > 0 ? Math.min(1, ahead / total) : 0
				})`;
			}
			const text = `${clock(now)} / ${clock(Math.round(total))}`;
			if (text !== shownText && timeRef.current) {
				shownText = text;
				timeRef.current.textContent = text;
				track.setAttribute("aria-valuenow", String(Math.floor(now)));
				track.setAttribute("aria-valuemax", String(Math.round(total)));
				track.setAttribute(
					"aria-valuetext",
					`${clock(now)} of ${clock(Math.round(total))}`,
				);
			}
		};

		const loop = () => {
			paint();
			frame = video.paused && !scrubbing ? 0 : requestAnimationFrame(loop);
		};

		const startLoop = () => {
			if (!frame) frame = requestAnimationFrame(loop);
		};

		const wake = () => {
			root.dataset.idle = "false";
			window.clearTimeout(idleTimer);
			idleTimer = window.setTimeout(() => {
				if (video.paused || scrubbing) return;
				if (root.querySelector(":focus-visible")) return;
				root.dataset.idle = "true";
			}, IDLE_AFTER_MS);
		};

		const setWaiting = (waiting: boolean) => {
			window.clearTimeout(waitTimer);
			if (!waiting) {
				root.dataset.waiting = "false";
				return;
			}
			waitTimer = window.setTimeout(() => {
				root.dataset.waiting = "true";
			}, 250);
		};

		const toggle = () => {
			if (video.paused || video.ended) {
				void video.play().catch(() => undefined);
			} else {
				video.pause();
			}
		};

		const seekTo = (seconds: number) => {
			const total = duration();
			if (total <= 0) return;
			video.currentTime = Math.min(total, Math.max(0, seconds));
			paint();
		};

		const toggleFullscreen = () => {
			if (document.fullscreenElement) {
				void document.exitFullscreen();
				return;
			}
			if (root.requestFullscreen) {
				void root.requestFullscreen().catch(() => undefined);
				return;
			}
			(video as FullscreenVideo).webkitEnterFullscreen?.();
		};

		const onPlay = () => {
			setPlaying(true);
			startLoop();
			wake();
			if (!started) {
				started = true;
				callbacks.current.onFirstPlay?.();
			}
		};
		const onPause = () => {
			setPlaying(false);
			root.dataset.idle = "false";
			paint();
		};
		const onEnded = () => {
			root.dataset.idle = "false";
			callbacks.current.onEnded?.();
		};
		const onVolume = () => setMuted(video.muted || video.volume === 0);
		const onResize = () => {
			if (qualityRef.current) {
				qualityRef.current.textContent = resolutionLabel(video.videoWidth);
			}
		};
		const onWaiting = () => setWaiting(true);
		const onReady = () => setWaiting(false);
		const onFullscreen = () =>
			setFullscreen(document.fullscreenElement === root);

		const fractionAt = (clientX: number) => {
			const box = track.getBoundingClientRect();
			return box.width > 0
				? Math.min(1, Math.max(0, (clientX - box.left) / box.width))
				: 0;
		};
		const onTrackDown = (event: PointerEvent) => {
			if (event.button !== 0) return;
			scrubbing = true;
			resumeAfterScrub = !video.paused;
			video.pause();
			track.setPointerCapture(event.pointerId);
			seekTo(fractionAt(event.clientX) * duration());
			startLoop();
		};
		const onTrackMove = (event: PointerEvent) => {
			if (scrubbing) seekTo(fractionAt(event.clientX) * duration());
		};
		const onTrackUp = (event: PointerEvent) => {
			if (!scrubbing) return;
			scrubbing = false;
			track.releasePointerCapture(event.pointerId);
			if (resumeAfterScrub) void video.play().catch(() => undefined);
		};

		const onKey = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const onButton = event.target instanceof HTMLButtonElement;
			const key = event.key.toLowerCase();
			if (key === " " || key === "k") {
				if (key === " " && onButton) return;
				toggle();
			} else if (key === "arrowleft") {
				seekTo(video.currentTime - SEEK_STEP_SECONDS);
			} else if (key === "arrowright") {
				seekTo(video.currentTime + SEEK_STEP_SECONDS);
			} else if (key === "home") {
				seekTo(0);
			} else if (key === "end") {
				seekTo(duration());
			} else if (key === "m") {
				video.muted = !video.muted;
			} else if (key === "f") {
				toggleFullscreen();
			} else {
				return;
			}
			event.preventDefault();
			wake();
		};

		const onAction = (event: Event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			const action =
				target.closest<HTMLElement>("[data-action]")?.dataset.action;
			if (action === "toggle") toggle();
			else if (action === "mute") video.muted = !video.muted;
			else if (action === "fullscreen") toggleFullscreen();
		};

		const videoEvents: [string, () => void][] = [
			["play", onPlay],
			["pause", onPause],
			["emptied", onPause],
			["ended", onEnded],
			["volumechange", onVolume],
			["resize", onResize],
			["loadedmetadata", paint],
			["durationchange", paint],
			["progress", paint],
			["seeked", paint],
			["timeupdate", paint],
			["waiting", onWaiting],
			["playing", onReady],
			["canplay", onReady],
			["seeked", onReady],
		];
		for (const [name, handler] of videoEvents) {
			video.addEventListener(name, handler);
		}
		track.addEventListener("pointerdown", onTrackDown);
		track.addEventListener("pointermove", onTrackMove);
		track.addEventListener("pointerup", onTrackUp);
		track.addEventListener("pointercancel", onTrackUp);
		root.addEventListener("keydown", onKey);
		root.addEventListener("click", onAction);
		root.addEventListener("pointermove", wake);
		root.addEventListener("focusin", wake);
		document.addEventListener("fullscreenchange", onFullscreen);

		onVolume();
		onResize();
		paint();
		if (!video.paused) onPlay();

		return () => {
			cancelAnimationFrame(frame);
			window.clearTimeout(idleTimer);
			window.clearTimeout(waitTimer);
			for (const [name, handler] of videoEvents) {
				video.removeEventListener(name, handler);
			}
			track.removeEventListener("pointerdown", onTrackDown);
			track.removeEventListener("pointermove", onTrackMove);
			track.removeEventListener("pointerup", onTrackUp);
			track.removeEventListener("pointercancel", onTrackUp);
			root.removeEventListener("keydown", onKey);
			root.removeEventListener("click", onAction);
			root.removeEventListener("pointermove", wake);
			root.removeEventListener("focusin", wake);
			document.removeEventListener("fullscreenchange", onFullscreen);
		};
	}, []);

	return (
		<div
			ref={rootRef}
			className={`${styles.player} ${className ?? ""}`}
			style={{ "--cap-player-ratio": aspectRatio } as CSSProperties}
			data-playing={playing}
			data-idle="false"
			data-waiting="false"
		>
			<video
				ref={videoRef}
				className={styles.video}
				poster={poster}
				preload="auto"
				playsInline
				data-action="toggle"
				aria-label={title}
			>
				<track kind="captions" />
			</video>
			<div className={styles.spinner} aria-hidden="true" />
			{failed ? (
				<p className={styles.failed} role="alert">
					This video could not be played.
				</p>
			) : null}
			<div className={styles.bar}>
				<button
					type="button"
					className={styles.control}
					data-action="toggle"
					aria-label={playing ? "Pause" : "Play"}
				>
					{playing ? <PauseIcon /> : <PlayIcon />}
				</button>
				<span ref={timeRef} className={styles.time}>
					0:00 / 0:00
				</span>
				<div
					ref={trackRef}
					className={styles.track}
					role="slider"
					tabIndex={0}
					aria-label="Seek"
					aria-valuemin={0}
					aria-valuemax={0}
					aria-valuenow={0}
				>
					<div className={styles.rail}>
						<div ref={bufferedRef} className={styles.buffered} />
						<div ref={playedRef} className={styles.played} />
					</div>
				</div>
				<span ref={qualityRef} className={styles.quality} />
				<button
					type="button"
					className={styles.control}
					data-action="mute"
					aria-label={muted ? "Unmute" : "Mute"}
				>
					<VolumeIcon muted={muted} />
				</button>
				<button
					type="button"
					className={styles.control}
					data-action="fullscreen"
					aria-label={fullscreen ? "Exit full screen" : "Full screen"}
				>
					<FullscreenIcon active={fullscreen} />
				</button>
			</div>
		</div>
	);
};
