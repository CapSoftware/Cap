import type { Video } from "@cap/web-domain";
import { useQuery } from "@tanstack/react-query";
import { getLiveTranscript } from "@/actions/videos/get-live-transcript";
import type { LiveTranscriptState } from "@/lib/live-transcribe-core";

export type LiveTranscriptData =
	| {
			kind: "ready";
			content: string;
			state: LiveTranscriptState;
			updatedAt?: string;
	  }
	/** No artifact yet — the first chunk hasn't landed; keep polling. */
	| { kind: "pending" }
	/** The server said nothing will ever appear for us — stop polling. */
	| { kind: "stopped" };

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
		queryFn: async (): Promise<LiveTranscriptData> => {
			const result = await getLiveTranscript(videoId);

			if (result.stop) return { kind: "stopped" };
			if (!result.success || !result.content) return { kind: "pending" };

			return {
				kind: "ready",
				content: result.content,
				state: result.state ?? "active",
				updatedAt: result.updatedAt,
			};
		},
		enabled,
		refetchInterval: (query) => {
			const data = query.state.data;
			if (data?.kind === "stopped") return false;
			if (data?.kind === "ready" && data.state !== "active") {
				return SETTLED_POLL_INTERVAL;
			}
			return ACTIVE_POLL_INTERVAL;
		},
		refetchIntervalInBackground: false,
		staleTime: 0,
		gcTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
		retry: false,
	});
};
