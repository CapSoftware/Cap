"use client";

import type { Video } from "@cap/web-domain";
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
import { renderProgressLabel, useRenderSaveStatus } from "./render-save-status";

const FINISHING_TIMEOUT_MS = 15_000;

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
		let cancelled = false;
		let release: (() => void) | undefined;
		void import("hls.js").then(({ default: Hls }) => {
			if (cancelled) return;
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
				release = () => hls.destroy();
			} else if (video.canPlayType("application/vnd.apple.mpegurl")) {
				video.src = src;
				release = () => {
					video.removeAttribute("src");
					video.load();
				};
			}
		});
		return () => {
			cancelled = true;
			release?.();
		};
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
	const status = useRenderSaveStatus(videoId, true, awaitingStart, true);
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
	// A render that published swaps this view out on the refresh. One that
	// ended without publishing leaves it here, and the upload plays instead.
	useEffect(() => {
		if (!finishing) return;
		const timer = setTimeout(() => setFinishing(false), FINISHING_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [finishing]);
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
				label={
					finishing || !rendering
						? "Finishing up"
						: renderProgressLabel(progress)
				}
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
