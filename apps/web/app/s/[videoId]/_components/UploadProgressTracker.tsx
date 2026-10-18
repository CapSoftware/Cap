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
	const key = uploadProgressKey(progress);
	const sent = useRef<{ key: string; onChange: typeof onChange } | null>(null);

	// The hook returns a new object every render; passing each one on would
	// re-render the player, and with it this tracker, forever. Only a committed
	// render reaches here, so what is sent is always what is on screen.
	useEffect(() => {
		if (sent.current?.key === key && sent.current.onChange === onChange) return;
		sent.current = { key, onChange };
		onChange(progress);
	});

	return null;
}
