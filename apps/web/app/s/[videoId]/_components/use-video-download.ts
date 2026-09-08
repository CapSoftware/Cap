"use client";

import type { Video } from "@cap/web-domain";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
	getVideoDownloadInfo,
	type VideoDownloadVariant,
} from "@/actions/videos/download";

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

				const { downloadUrl, filename } = result;
				const response = await fetch(downloadUrl);
				if (!response.ok) throw new Error("Failed to download video");
				const blob = await response.blob();
				const blobUrl = window.URL.createObjectURL(blob);
				const link = document.createElement("a");
				link.href = blobUrl;
				link.download = filename;
				link.style.display = "none";
				document.body.appendChild(link);
				link.click();
				document.body.removeChild(link);
				window.URL.revokeObjectURL(blobUrl);
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
