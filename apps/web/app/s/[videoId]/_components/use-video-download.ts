"use client";

import type { Video } from "@cap/web-domain";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
	getVideoDownloadInfo,
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

	const download = useCallback(
		(variant: VideoDownloadVariant) => {
			if (isDownloading) return;
			setIsDownloading(true);

			const run = async () => {
				const result = await getVideoDownloadInfo(videoId, variant);
				if (!result.success) {
					throw new Error(result.error);
				}

				startBrowserDownload(result.downloadUrl);
			};

			const promise = run();
			toast.promise(promise, {
				loading: "Preparing download...",
				success: "Download started",
				error: (error) =>
					error instanceof Error ? error.message : "Failed to download video",
			});
			promise.catch(() => undefined).finally(() => setIsDownloading(false));
		},
		[videoId, isDownloading],
	);

	return { download, isDownloading };
}
