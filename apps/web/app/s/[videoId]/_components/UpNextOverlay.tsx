"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { SpaceUpNext } from "@/lib/space-up-next";
import { markUpNextContinue, whenVideoMounted } from "./up-next-playback";

export const UP_NEXT_COUNTDOWN_SECONDS = 8;
const AUTOPLAY_STORAGE_KEY = "cap:space-autoplay";
const RING_RADIUS = 15;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function readAutoplay() {
	try {
		return window.localStorage.getItem(AUTOPLAY_STORAGE_KEY) !== "off";
	} catch {
		return true;
	}
}

function writeAutoplay(enabled: boolean) {
	try {
		window.localStorage.setItem(AUTOPLAY_STORAGE_KEY, enabled ? "on" : "off");
	} catch {}
}

function formatDuration(seconds: number | null) {
	if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
	const total = Math.round(seconds);
	const minutes = Math.floor(total / 60);
	return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

export function upNextHref(upNext: SpaceUpNext) {
	return `/s/${upNext.video.id}?space=${encodeURIComponent(upNext.spaceId)}`;
}

export function UpNextOverlay({
	upNext,
	videoRef,
	holdAutoplay = false,
}: {
	upNext: SpaceUpNext;
	videoRef: RefObject<HTMLVideoElement | null>;
	holdAutoplay?: boolean;
}) {
	const router = useRouter();
	const reduceMotion = useReducedMotion();
	const [ended, setEnded] = useState(false);
	const [autoplay, setAutoplay] = useState(true);
	const [cancelled, setCancelled] = useState(false);
	const [remaining, setRemaining] = useState(UP_NEXT_COUNTDOWN_SECONDS);
	const navigatedRef = useRef(false);
	const href = upNextHref(upNext);

	useEffect(() => {
		setAutoplay(readAutoplay());
	}, []);

	useEffect(() => {
		const onEnded = () => {
			setEnded(true);
			setCancelled(false);
			setRemaining(UP_NEXT_COUNTDOWN_SECONDS);
		};
		const onResume = () => setEnded(false);
		return whenVideoMounted(videoRef, (video) => {
			video.addEventListener("ended", onEnded);
			video.addEventListener("play", onResume);
			video.addEventListener("seeking", onResume);
			return () => {
				video.removeEventListener("ended", onEnded);
				video.removeEventListener("play", onResume);
				video.removeEventListener("seeking", onResume);
			};
		});
	}, [videoRef]);

	const playNext = useCallback(() => {
		if (navigatedRef.current) return;
		navigatedRef.current = true;
		markUpNextContinue(upNext.video.id);
		router.push(href);
	}, [href, router, upNext.video.id]);

	useEffect(() => {
		router.prefetch(href);
	}, [href, router]);

	const counting = ended && autoplay && !cancelled && !holdAutoplay;

	useEffect(() => {
		if (!counting) return;
		if (remaining <= 0) {
			playNext();
			return;
		}
		const timer = window.setTimeout(() => setRemaining((r) => r - 1), 1000);
		return () => window.clearTimeout(timer);
	}, [counting, remaining, playNext]);

	const toggleAutoplay = () => {
		setAutoplay((current) => {
			writeAutoplay(!current);
			return !current;
		});
		setRemaining(UP_NEXT_COUNTDOWN_SECONDS);
	};

	const duration = formatDuration(upNext.video.duration);
	const progress = counting ? remaining / UP_NEXT_COUNTDOWN_SECONDS : 1;

	return (
		<AnimatePresence>
			{ended && (
				<motion.section
					key="up-next"
					aria-label={`Up next in ${upNext.spaceName}`}
					initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
					animate={{ opacity: 1, y: 0 }}
					exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
					transition={{ duration: 0.2, ease: "easeOut" }}
					className="absolute top-3 right-3 z-[46] w-[min(320px,calc(100%-1.5rem))] rounded-xl border border-white/10 bg-black/75 p-3 text-white shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-md"
				>
					<div className="flex gap-3 items-center">
						<button
							type="button"
							onClick={playNext}
							className="overflow-hidden relative w-24 rounded-lg aspect-video shrink-0 bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
							aria-label={`Play ${upNext.video.name}`}
						>
							<Image
								src={`/api/video/preview?videoId=${upNext.video.id}&fallback=og`}
								alt=""
								fill
								sizes="96px"
								unoptimized
								className="object-cover"
							/>
							<span className="flex absolute inset-0 justify-center items-center bg-black/30">
								<svg
									viewBox="0 0 36 36"
									className="size-9 -rotate-90"
									aria-hidden="true"
								>
									<circle
										cx="18"
										cy="18"
										r={RING_RADIUS}
										fill="rgba(0,0,0,0.35)"
										stroke="rgba(255,255,255,0.25)"
										strokeWidth="2.5"
									/>
									<circle
										cx="18"
										cy="18"
										r={RING_RADIUS}
										fill="none"
										stroke="white"
										strokeWidth="2.5"
										strokeLinecap="round"
										strokeDasharray={RING_CIRCUMFERENCE}
										strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress)}
										className={
											reduceMotion
												? undefined
												: "transition-[stroke-dashoffset] duration-1000 ease-linear"
										}
									/>
									<path
										d="M15 12.5v11l9-5.5z"
										fill="white"
										transform="rotate(90 18 18)"
									/>
								</svg>
							</span>
						</button>
						<div className="flex flex-col flex-1 gap-0.5 min-w-0">
							<p className="text-xs text-white/70" aria-live="polite">
								{counting ? `Up next in ${remaining}` : "Up next"}
							</p>
							<p className="text-sm font-medium leading-snug line-clamp-2">
								{upNext.video.name}
							</p>
							<p className="text-xs truncate text-white/60">
								{duration ? `${duration} · ` : ""}
								{upNext.spaceName}
							</p>
						</div>
					</div>
					<div className="flex gap-2 justify-between items-center mt-3">
						<button
							type="button"
							role="switch"
							aria-checked={autoplay}
							onClick={toggleAutoplay}
							className="flex gap-2 items-center text-xs rounded-md select-none text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
						>
							<span
								aria-hidden
								className={`relative h-[18px] w-8 rounded-full transition-colors ${autoplay ? "bg-white" : "bg-white/25"}`}
							>
								<span
									className={`absolute top-[2px] left-0 size-[14px] rounded-full transition-transform ${autoplay ? "translate-x-[16px] bg-black" : "translate-x-[2px] bg-white"}`}
								/>
							</span>
							Autoplay
						</button>
						<div className="flex gap-1.5">
							{counting && (
								<button
									type="button"
									onClick={() => setCancelled(true)}
									className="px-2.5 h-7 text-xs font-medium rounded-md transition-colors text-white/85 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
								>
									Cancel
								</button>
							)}
							<button
								type="button"
								onClick={playNext}
								className="px-2.5 h-7 text-xs font-medium text-black bg-white rounded-md transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
							>
								Play now
							</button>
						</div>
					</div>
				</motion.section>
			)}
		</AnimatePresence>
	);
}
