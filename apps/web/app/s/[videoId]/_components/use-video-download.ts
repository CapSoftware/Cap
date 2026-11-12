"use client";

import type { Video } from "@cap/web-domain";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
	getVideoAudioDownloadInfo,
	getVideoDownloadInfo,
	type VideoDownloadInfo,
	type VideoDownloadVariant,
} from "@/actions/videos/download";
import { startBrowserDownload } from "@/lib/start-browser-download";

/**
 * Fetches a signed URL and saves it to disk, with a toast for the wait.
 *
 * Shared because downloads are offered from three places now: the editor's
 * own menu, the share page's "Manage Cap" menu, and the plain Download button
 * a space member sees on someone else's Cap.
 */
export function useVideoDownload(videoId: Video.VideoId) {
	const [isDownloading, setIsDownloading] = useState(false);

	const start = useCallback(
		(
			getInfo: () => Promise<VideoDownloadInfo>,
			messages: { loading: string; fallbackError: string },
		) => {
			if (isDownloading) return;
			setIsDownloading(true);

			const run = async () => {
				const result = await getInfo();
				if (!result.success) {
					throw new Error(result.error);
				}

				startBrowserDownload(result.downloadUrl);
			};

			const promise = run();
			toast.promise(promise, {
				loading: messages.loading,
				success: "Download started",
				error: (error) =>
					error instanceof Error ? error.message : messages.fallbackError,
			});
			promise.catch(() => undefined).finally(() => setIsDownloading(false));
		},
		[isDownloading],
	);

	const download = useCallback(
		(variant: VideoDownloadVariant) =>
			start(() => getVideoDownloadInfo(videoId, variant), {
				loading: "Preparing download...",
				fallbackError: "Failed to download video",
			}),
		[start, videoId],
	);

	const downloadAudio = useCallback(
		() =>
			start(() => getVideoAudioDownloadInfo(videoId), {
				loading: "Preparing audio...",
				fallbackError: "Failed to download audio",
			}),
		[start, videoId],
	);

	return { download, downloadAudio, isDownloading };
}
