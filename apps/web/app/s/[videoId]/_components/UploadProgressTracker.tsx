"use client";

import type { Video } from "@cap/web-domain";
import { useEffect } from "react";
import { useUploadProgress } from "./ProgressCircle";
import type { UploadProgress } from "./upload-progress";

/**
 * Headless bridge around `useUploadProgress`. The hook's RPC client pulls the
 * Effect runtime with it, so the players mount this (dynamically imported)
 * only while a video actually has a live upload — every finished video skips
 * the chunk entirely.
 */
export default function UploadProgressTracker({
	videoId,
	onChange,
}: {
	videoId: Video.VideoId;
	onChange: (progress: UploadProgress | null) => void;
}) {
	const progress = useUploadProgress(videoId, true);

	useEffect(() => {
		onChange(progress);
	}, [progress, onChange]);

	return null;
}
