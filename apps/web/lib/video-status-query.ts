import type { Video } from "@cap/web-domain";
import {
	getVideoStatus,
	type VideoStatusResult,
} from "@/actions/videos/get-status";

export class VideoStatusNotFoundError extends Error {
	constructor() {
		super("This video is no longer available");
		this.name = "VideoStatusNotFoundError";
	}
}

export function videoStatusQueryOptions(videoId: Video.VideoId) {
	return {
		queryKey: ["videoStatus", videoId],
		queryFn: async (): Promise<VideoStatusResult> => {
			const result = await getVideoStatus(videoId);
			if ("success" in result) {
				if (result.reason === "not_found") throw new VideoStatusNotFoundError();
				throw new Error("Failed to fetch video status");
			}
			return result;
		},
		retry: (failureCount: number, error: Error) =>
			!(error instanceof VideoStatusNotFoundError) && failureCount < 3,
	};
}
