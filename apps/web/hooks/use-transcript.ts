import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getTranscript } from "@/actions/videos/get-transcript";

export const useTranscript = (
	videoId: string,
	transcriptionStatus?: string | null,
) => {
	return useQuery({
		queryKey: ["transcript", videoId],
		queryFn: async () => {
			// For PENDING status, don't try to fetch transcript
			if (transcriptionStatus === "PENDING") {
				throw new Error("TRANSCRIPT_PENDING");
			}

			const result = await getTranscript(videoId);

			if (result.success && result.content) {
				return result.content;
			} else {
				console.error(
					"[useTranscript] Failed to fetch transcript:",
					result.message,
				);
				if (result.message === "Transcript is not ready yet") {
					throw new Error("TRANSCRIPT_NOT_READY");
				}
				throw new Error(result.message);
			}
		},
		enabled: transcriptionStatus === "COMPLETE" || transcriptionStatus === "PENDING",
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
