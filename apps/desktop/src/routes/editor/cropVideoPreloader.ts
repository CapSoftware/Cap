import { convertFileSrc } from "@tauri-apps/api/core";

let preloadedVideo: HTMLVideoElement | null = null;
let preloadState: "idle" | "metadata" | "full" | "ready" = "idle";
let currentVideoPath: string | null = null;

export function preloadCropVideoMetadata(videoPath: string) {
	if (preloadState !== "idle") return;

	currentVideoPath = videoPath;
	preloadedVideo = document.createElement("video");
	preloadedVideo.preload = "metadata";
	preloadedVideo.src = convertFileSrc(videoPath);
	preloadedVideo.muted = true;
	preloadedVideo.load();
	preloadState = "metadata";
}

export function preloadCropVideoFull() {
	if (!preloadedVideo || preloadState === "full" || preloadState === "ready")
		return;

	preloadedVideo.preload = "auto";
	preloadedVideo.load();
	preloadState = "full";

	preloadedVideo.oncanplaythrough = () => {
		preloadState = "ready";
	};
}

export function getPreloadState() {
	return preloadState;
}

export function getPreloadedVideoPath() {
	return currentVideoPath;
}

export function cleanup() {
	if (preloadedVideo) {
		preloadedVideo.src = "";
		preloadedVideo = null;
	}
	currentVideoPath = null;
	preloadState = "idle";
}
