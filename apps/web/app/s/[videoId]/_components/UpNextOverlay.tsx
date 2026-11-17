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
import { markUpNextContinue, onPlayerMediaEvent } from "./up-next-playback";

export const UP_NEXT_COUNTDOWN_SECONDS = 8;
const AUTOPLAY_STORAGE_KEY = "cap:space-autoplay";
const RING_RADIUS = 20;

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

function useThumbnailUrl(videoId: string) {
	const [url, setUrl] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		fetch(`/api/thumbnail?videoId=${encodeURIComponent(videoId)}`, {
			signal: controller.signal,
		})
			.then((response) => (response.ok ? response.json() : null))
			.then((body: unknown) => {
				if (
					body &&
					typeof body === "object" &&
					"screen" in body &&
					typeof body.screen === "string"
				) {
					setUrl(body.screen);
				}
			})
			.catch(() => {});
		return () => controller.abort();
	}, [videoId]);

	return url;
}

const isTypingTarget = (target: EventTarget | null) =>
	target instanceof HTMLElement &&
	(target.isContentEditable ||
		["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

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
	const [fullscreen, setFullscreen] = useState(false);
	const [thumbnailLoaded, setThumbnailLoaded] = useState(false);
	const navigatedRef = useRef(false);
	const href = upNextHref(upNext);
	const thumbnailUrl = useThumbnailUrl(upNext.video.id);

	useEffect(() => {
		setAutoplay(readAutoplay());
	}, []);

	useEffect(() => {
		if (videoRef.current?.ended) setEnded(true);
		return onPlayerMediaEvent(
			videoRef,
			["ended", "play", "seeking"],
			(_, event) => {
				if (event.type === "ended") {
					setEnded(true);
					setCancelled(false);
					setRemaining(UP_NEXT_COUNTDOWN_SECONDS);
				} else setEnded(false);
			},
		);
	}, [videoRef]);

	// The player goes fullscreen on its own root, which this card is not part
	// of, so the countdown waits until the viewer can see it.
	useEffect(() => {
		const update = () => setFullscreen(document.fullscreenElement !== null);
		update();
		document.addEventListener("fullscreenchange", update);
		return () => document.removeEventListener("fullscreenchange", update);
	}, []);

	const playNext = useCallback(() => {
		if (navigatedRef.current) return;
		navigatedRef.current = true;
		markUpNextContinue(upNext.video.id);
		router.push(href);
	}, [href, router, upNext.video.id]);

	useEffect(() => {
		router.prefetch(href);
	}, [href, router]);

	const counting =
		ended && autoplay && !cancelled && !holdAutoplay && !fullscreen;

	useEffect(() => {
		if (!counting) return;
		if (remaining <= 0) {
			playNext();
			return;
		}
		const timer = window.setTimeout(() => setRemaining((r) => r - 1), 1000);
		return () => window.clearTimeout(timer);
	}, [counting, remaining, playNext]);

	useEffect(() => {
		if (!counting) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				isTypingTarget(event.target) ||
				document.querySelector('[role="dialog"], [role="alertdialog"]')
			)
				return;
			setCancelled(true);
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [counting]);

	const toggleAutoplay = () => {
		setAutoplay((current) => {
			writeAutoplay(!current);
			return !current;
		});
		setRemaining(UP_NEXT_COUNTDOWN_SECONDS);
	};

	const duration = formatDuration(upNext.video.duration);
	const elapsedFraction =
		(UP_NEXT_COUNTDOWN_SECONDS - remaining) / UP_NEXT_COUNTDOWN_SECONDS;

	return (
		<AnimatePresence>
			{ended && (
				<motion.section
					key="up-next"
					aria-label={`Up next in ${upNext.spaceName}`}
					initial={
						reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }
					}
					animate={{ opacity: 1, y: 0, scale: 1 }}
					exit={
						reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }
					}
					transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
					className="absolute top-2 right-2 z-[46] w-[min(340px,calc(100%-1rem))] origin-top-right rounded-xl border border-white/10 bg-black/80 p-2 sm:top-3 sm:right-3 sm:w-[min(340px,calc(100%-1.5rem))] sm:rounded-2xl sm:p-2.5 text-white shadow-[0_16px_48px_rgba(0,0,0,0.5)] backdrop-blur-xl"
				>
					<div className="flex gap-3 items-center">
						<button
							type="button"
							onClick={playNext}
							className="group overflow-hidden relative w-[84px] rounded-lg aspect-video sm:w-[120px] sm:rounded-xl shrink-0 bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
							aria-label={`Play ${upNext.video.name}`}
						>
							{thumbnailUrl && (
								<Image
									src={thumbnailUrl}
									alt=""
									fill
									sizes="(min-width: 640px) 120px, 84px"
									unoptimized
									onLoad={() => setThumbnailLoaded(true)}
									className={`object-cover transition-[opacity,transform] duration-300 ease-out group-hover:scale-[1.04] ${thumbnailLoaded ? "opacity-100" : "opacity-0"}`}
								/>
							)}
							<span className="flex absolute inset-0 justify-center items-center bg-black/25 transition-colors group-hover:bg-black/10">
								<svg
									viewBox="0 0 48 48"
									className="size-9 sm:size-11 drop-shadow-[0_1px_4px_rgba(0,0,0,0.4)]"
									aria-hidden="true"
								>
									<circle
										cx="24"
										cy="24"
										r={RING_RADIUS}
										fill="rgba(0,0,0,0.45)"
									/>
									{counting && (
										<>
											<circle
												cx="24"
												cy="24"
												r={RING_RADIUS}
												fill="none"
												stroke="rgba(255,255,255,0.22)"
												strokeWidth="2.5"
											/>
											<motion.circle
												cx="24"
												cy="24"
												r={RING_RADIUS}
												fill="none"
												stroke="white"
												strokeWidth="2.5"
												strokeLinecap="round"
												transform="rotate(-90 24 24)"
												initial={{ pathLength: elapsedFraction }}
												animate={{ pathLength: 1 }}
												transition={{
													duration: reduceMotion ? 0 : remaining,
													ease: "linear",
												}}
											/>
										</>
									)}
									<path d="M20.5 17v14l11-7z" fill="white" />
								</svg>
							</span>
						</button>
						<div className="flex flex-col flex-1 gap-0.5 min-w-0">
							<p className="text-xs tabular-nums text-white/65">
								{counting ? `Up next in ${remaining}` : "Up next"}
							</p>
							<p className="text-sm font-medium leading-snug line-clamp-1 sm:line-clamp-2">
								{upNext.video.name}
							</p>
							<p className="text-xs truncate text-white/55">
								{duration ? `${duration} · ` : ""}
								{upNext.spaceName}
							</p>
						</div>
					</div>
					<div className="flex gap-2 justify-between items-center pl-0.5 mt-2 sm:mt-2.5">
						<button
							type="button"
							role="switch"
							aria-checked={autoplay}
							onClick={toggleAutoplay}
							className="flex gap-2 items-center px-1 -mx-1 h-7 text-xs rounded-md transition-colors select-none text-white/75 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
						>
							<span
								aria-hidden
								className={`relative h-[18px] w-[30px] rounded-full transition-colors duration-200 ease-out ${autoplay ? "bg-white" : "bg-white/20"}`}
							>
								<span
									className={`absolute top-[2px] left-[2px] size-[14px] rounded-full shadow-sm transition-[transform,background-color] duration-200 ease-out ${autoplay ? "translate-x-[12px] bg-black" : "translate-x-0 bg-white"}`}
								/>
							</span>
							Autoplay
						</button>
						<div className="flex gap-1.5">
							{counting && (
								<button
									type="button"
									onClick={() => setCancelled(true)}
									aria-keyshortcuts="Escape"
									className="px-3 h-7 text-xs font-medium rounded-lg transition-colors text-white/85 hover:bg-white/10 hover:text-white active:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
								>
									Cancel
								</button>
							)}
							<button
								type="button"
								onClick={playNext}
								className="px-3 h-7 text-xs font-medium text-black bg-white rounded-lg transition-[background-color,transform] duration-150 hover:bg-white/90 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
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
