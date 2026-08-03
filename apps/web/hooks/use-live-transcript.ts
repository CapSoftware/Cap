import type { Video } from "@cap/web-domain";
import { useQuery } from "@tanstack/react-query";
import { getLiveTranscript } from "@/actions/videos/get-live-transcript";
import type { LiveTranscriptState } from "@/lib/live-transcribe-core";

export interface LiveTranscriptData {
	content: string;
	state: LiveTranscriptState;
	updatedAt?: string;
}

/** Live transcription is still appending; poll often enough to feel live. */
const ACTIVE_POLL_INTERVAL = 5000;
/** Live transcription finished; the canonical transcript supersedes it
 * shortly, so only poll slowly for content written between renders. */
const SETTLED_POLL_INTERVAL = 15000;

/**
 * Provisional transcript of an instant-mode recording that is still uploading.
 * `enabled` must already account for the video being a `desktopSegments`
 * recording with live transcription started and no canonical transcript yet —
 * when it is false nothing is ever fetched.
 */
export const useLiveTranscript = (videoId: Video.VideoId, enabled: boolean) => {
	return useQuery({
		queryKey: ["liveTranscript", videoId],
		queryFn: async (): Promise<LiveTranscriptData | null> => {
			const result = await getLiveTranscript(videoId);

			if (!result.success || !result.content) return null;

			return {
				content: result.content,
				state: result.state ?? "active",
				updatedAt: result.updatedAt,
			};
		},
		enabled,
		refetchInterval: (query) => {
			const state = query.state.data?.state;
			return state === "complete" || state === "stopped"
				? SETTLED_POLL_INTERVAL
				: ACTIVE_POLL_INTERVAL;
		},
		refetchIntervalInBackground: false,
		staleTime: 0,
		gcTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
		retry: false,
	});
};
