"use client";

import type { Video } from "@cap/web-domain";
import Hls from "hls.js";
import { useRouter } from "next/navigation";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import { RenderFog } from "@/components/render-fog";
import { useThumnailQuery } from "@/components/VideoThumbnail";
import { scheduleReadyRefresh } from "./deferred-ready-refresh";

type RenderSaveStatus = {
	state: "idle" | "rendering" | "ready" | "error";
	progress: number;
	playable: boolean;
	hlsUrl: string | null;
	error: string | null;
};

const POLL_MS = 3000;

/**
 * Polls a render while it's running, and with `untilStarted`, while one that
 * is about to start hasn't reported yet.
 */
export function useRenderSaveStatus(
	videoId: string,
	enabled = true,
	untilStarted = false,
) {
	const [status, setStatus] = useState<RenderSaveStatus | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const controller = new AbortController();
		const poll = async () => {
			try {
				const response = await fetch(
					`/api/videos/${encodeURIComponent(videoId)}/render-status`,
					{ cache: "no-store", signal: controller.signal },
				);
				if (response.ok) {
					const next = (await response.json()) as RenderSaveStatus;
					setStatus(next);
					if (next.state !== "rendering" && !untilStarted) return;
				}
			} catch {
				if (controller.signal.aborted) return;
			}
			timer = setTimeout(poll, POLL_MS);
		};
		void poll();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [videoId, enabled, untilStarted]);
	return status;
}

/** How far a render has got, worded the same on the share page and dashboard. */
export function renderProgressLabel(progress: number) {
	const percent = Math.floor(progress * 100);
	return percent > 0 ? `Rendering · ${percent}%` : "Getting the video ready";
}

function RenderPreviewPlayer({
	src,
	videoRef,
	className,
	onWaitingChange,
}: {
	src: string;
	videoRef: RefObject<HTMLVideoElement | null>;
	className?: string;
	onWaitingChange: (waiting: boolean) => void;
}) {
	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		const waiting = () => onWaitingChange(true);
		const moving = () => onWaitingChange(false);
		video.addEventListener("waiting", waiting);
		video.addEventListener("playing", moving);
		video.addEventListener("seeking", moving);
		video.addEventListener("pause", moving);
		return () => {
			video.removeEventListener("waiting", waiting);
			video.removeEventListener("playing", moving);
			video.removeEventListener("seeking", moving);
			video.removeEventListener("pause", moving);
		};
	}, [videoRef, onWaitingChange]);
	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		if (Hls.isSupported()) {
			// The render's playlist grows from the start while it renders; begin
			// there rather than at the live edge.
			const hls = new Hls({
				startPosition: 0,
				manifestLoadingMaxRetry: 30,
				levelLoadingMaxRetry: 30,
				fragLoadingMaxRetry: 30,
			});
			hls.loadSource(src);
			hls.attachMedia(video);
			return () => hls.destroy();
		}
		if (video.canPlayType("application/vnd.apple.mpegurl")) {
			video.src = src;
			return () => {
				video.removeAttribute("src");
				video.load();
			};
		}
	}, [src, videoRef]);
	return (
		<video ref={videoRef} controls playsInline className={className}>
			<track kind="captions" />
		</video>
	);
}

/**
 * A video still rendering on the render farm: fog until its first part is
 * ready, then it plays up to where the render has reached, with fog over the
 * frame while playback waits for the rest.
 */
export function RenderFarmSaveView({
	videoId,
	videoRef,
	fallback,
	startingRender = false,
	className,
}: {
	videoId: Video.VideoId;
	videoRef: RefObject<HTMLVideoElement | null>;
	fallback: ReactNode;
	/** A render this page is about to start, which may not have reported yet. */
	startingRender?: boolean;
	className?: string;
}) {
	const [awaitingStart, setAwaitingStart] = useState(startingRender);
	const status = useRenderSaveStatus(videoId, true, awaitingStart);
	const poster = useThumnailQuery(videoId).data;
	const router = useRouter();
	const [playlist, setPlaylist] = useState<string | null>(null);
	const [waiting, setWaiting] = useState(false);
	const [finishing, setFinishing] = useState(false);

	useEffect(() => {
		if (!awaitingStart) return;
		const timer = setTimeout(() => setAwaitingStart(false), 30_000);
		return () => clearTimeout(timer);
	}, [awaitingStart]);
	const sawRendering = useRef(false);

	// A Save rendered in the owner's browser has no render to stream here: it
	// replaces the share video, so its end is a cue to load the page again.
	useEffect(() => {
		if (status?.state === "rendering") {
			sawRendering.current = true;
			setAwaitingStart(false);
		} else if (status?.state === "idle" && sawRendering.current) {
			setFinishing(true);
			router.refresh();
		}
	}, [status?.state, router]);

	useEffect(() => {
		if (status?.playable && status.hlsUrl && !playlist) {
			setPlaylist(status.hlsUrl);
		}
	}, [status, playlist]);

	useEffect(() => {
		if (status?.state !== "ready") return;
		return scheduleReadyRefresh({
			video: videoRef.current,
			videoId,
			refresh: () => router.refresh(),
		});
	}, [status?.state, videoId, videoRef, router]);

	if (
		status?.state === "error" ||
		(status?.state === "idle" && !finishing && !awaitingStart)
	)
		return fallback;
	const progress = status?.progress ?? 0;
	const rendering = status?.state !== "ready";
	if (!playlist) {
		return (
			<RenderFog
				poster={poster}
				className={className}
				label={finishing ? "Finishing up" : renderProgressLabel(progress)}
				detail="It plays here as soon as it's ready."
				progress={progress}
			/>
		);
	}
	return (
		<div className={`relative overflow-hidden bg-black ${className ?? ""}`}>
			<RenderPreviewPlayer
				src={playlist}
				videoRef={videoRef}
				className="w-full h-full"
				onWaitingChange={setWaiting}
			/>
			{rendering && waiting && (
				<RenderFog
					overlay
					className="pointer-events-none"
					label="Rendering the rest"
					detail="Playback carries on as soon as it's ready."
					progress={progress}
				/>
			)}
			<div className="pointer-events-none absolute top-3 right-3 flex items-center gap-1.5 rounded-md bg-black/65 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
				{rendering && (
					<span className="size-1.5 animate-pulse rounded-full bg-white" />
				)}
				{rendering ? renderProgressLabel(progress) : "Ready"}
			</div>
		</div>
	);
}
