import type { Video } from "@inflight/web-domain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getTranscript } from "@/actions/videos/get-transcript";

export const useTranscript = (
	videoId: Video.VideoId,
	transcriptionStatus?: string | null,
) => {
	return useQuery({
		queryKey: ["transcript", videoId],
		queryFn: async () => {
			const result = await getTranscript(videoId);

			if (result.success && result.content) {
				return result.content;
			} else {
				if (result.message === "Transcript is not ready yet") {
					throw new Error("TRANSCRIPT_NOT_READY");
				}
				throw new Error(result.message);
			}
		},
		enabled: transcriptionStatus === "COMPLETE",
		staleTime: 0,
		refetchOnWindowFocus: false,
	});
};

export const useInvalidateTranscript = () => {
	const queryClient = useQueryClient();

	return (videoId: string) => {
		queryClient.invalidateQueries({ queryKey: ["transcript", videoId] });
	};
};
