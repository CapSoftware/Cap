import type { Video } from "@cap/web-domain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { getTranscript } from "@/actions/videos/get-transcript";

export const useTranscript = (
	videoId: Video.VideoId,
	transcriptionStatus?: string | null,
) => {
	const queryClient = useQueryClient();
	const previousStatus = useRef(transcriptionStatus);

	useEffect(() => {
		if (
			previousStatus.current !== "COMPLETE" &&
			transcriptionStatus === "COMPLETE"
		) {
			queryClient.invalidateQueries({ queryKey: ["transcript", videoId] });
		}
		previousStatus.current = transcriptionStatus;
	}, [transcriptionStatus, videoId, queryClient]);

	return useQuery({
		queryKey: ["transcript", videoId],
		queryFn: async () => {
			const result = await getTranscript(videoId);

			if (result.success && result.content) {
				return result.content;
			}
			if (result.message === "Transcript is not ready yet") {
				throw new Error("TRANSCRIPT_NOT_READY");
			}
			throw new Error(result.message);
		},
		enabled: transcriptionStatus === "COMPLETE",
		staleTime: 30 * 60 * 1000,
		gcTime: 60 * 60 * 1000,
		refetchOnWindowFocus: false,
		retry: (failureCount, error) => {
			if (error.message === "TRANSCRIPT_NOT_READY") {
				return failureCount < 3;
			}
			return false;
		},
		retryDelay: 1000,
	});
};

export const useInvalidateTranscript = () => {
	const queryClient = useQueryClient();

	return (videoId: string) => {
		queryClient.invalidateQueries({ queryKey: ["transcript", videoId] });
	};
};
