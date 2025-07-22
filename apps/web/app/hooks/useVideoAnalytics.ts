"use server";

import { useQuery } from "@tanstack/react-query";
import { getVideoAnalytics } from "@/actions/videos/get-analytics";

export const useVideoAnalytics = async (videoId: string) => {
  return useQuery({
    queryKey: ["videoAnalytics", videoId],
    queryFn: async () => {
      const result = await getVideoAnalytics(videoId);
      return result.count || 0;
    },
    refetchOnWindowFocus: false,
  });
};
