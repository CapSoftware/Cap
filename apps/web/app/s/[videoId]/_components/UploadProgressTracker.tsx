"use client";

import type { Video } from "@cap/web-domain";
import { useEffect, useRef } from "react";
import { useUploadProgress } from "./ProgressCircle";
import { type UploadProgress, uploadProgressKey } from "./upload-progress";

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
	const latest = useRef(progress);
	latest.current = progress;
	// The hook returns a new object every render; passing each one on would
	// re-render the player, and with it this tracker, forever.
	const key = uploadProgressKey(progress);

	useEffect(() => {
		void key;
		onChange(latest.current);
	}, [key, onChange]);

	return null;
}
