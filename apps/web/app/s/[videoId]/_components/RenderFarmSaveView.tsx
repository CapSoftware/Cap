"use client";

import Hls from "hls.js";
import { useRouter } from "next/navigation";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { scheduleReadyRefresh } from "./deferred-ready-refresh";
import { PreparingVideoOverlay } from "./RecordingInProgress";

type RenderSaveStatus = {
	state: "idle" | "rendering" | "ready" | "error";
	progress: number;
	playable: boolean;
	hlsUrl: string | null;
	error: string | null;
};

const POLL_MS = 3000;

function useRenderSaveStatus(videoId: string) {
	const [status, setStatus] = useState<RenderSaveStatus | null>(null);
	useEffect(() => {
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
					if (next.state !== "rendering") return;
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
	}, [videoId]);
	return status;
}

function RenderPreviewPlayer({
	src,
	videoRef,
	className,
}: {
	src: string;
	videoRef: RefObject<HTMLVideoElement | null>;
	className?: string;
}) {
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

export function RenderFarmSaveView({
	videoId,
	videoRef,
	fallback,
	className,
}: {
	videoId: string;
	videoRef: RefObject<HTMLVideoElement | null>;
	fallback: ReactNode;
	className?: string;
}) {
	const status = useRenderSaveStatus(videoId);
	const router = useRouter();
	const [playlist, setPlaylist] = useState<string | null>(null);

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

	if (status?.state === "error" || status?.state === "idle") return fallback;
	const percent = Math.floor((status?.progress ?? 0) * 100);
	if (!playlist) {
		return (
			<PreparingVideoOverlay
				className={className}
				label={
					percent > 0
						? `Rendering the new version… ${percent}%`
						: "Preparing the new version…"
				}
			/>
		);
	}
	return (
		<div className={`relative overflow-hidden bg-black ${className ?? ""}`}>
			<RenderPreviewPlayer
				src={playlist}
				videoRef={videoRef}
				className="w-full h-full"
			/>
			<div className="absolute top-3 right-3 rounded-md bg-black/65 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
				{status?.state === "ready"
					? "New version ready"
					: `Rendering new version · ${percent}%`}
			</div>
		</div>
	);
}
