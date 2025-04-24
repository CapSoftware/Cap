"use client";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { apiClient } from "@/utils/web-api";
import { VideoMetadata } from "@cap/database/types";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { CapCard } from "./components/CapCard";
import { CapPagination } from "./components/CapPagination";
import { EmptyCapState } from "./components/EmptyCapState";

type VideoData = {
  id: string;
  ownerId: string;
  name: string;
  createdAt: Date;
  totalComments: number;
  totalReactions: number;
  sharedSpaces: { id: string; name: string }[];
  ownerName: string;
  metadata?: VideoMetadata;
}[];

export const Caps = ({
  data,
  count,
  userSpaces,
}: {
  data: VideoData;
  count: number;
  userSpaces: { id: string; name: string }[];
}) => {
  const { refresh } = useRouter();
  const params = useSearchParams();
  const page = Number(params.get("page")) || 1;
  const [analytics, setAnalytics] = useState<Record<string, number>>({});
  const { user } = useSharedContext();
  const limit = 15;
  const totalPages = Math.ceil(count / limit);

  useEffect(() => {
    const fetchAnalytics = async () => {
      const analyticsData: Record<string, number> = {};

      for (const video of data) {
        const response = await apiClient.video.getAnalytics({
          query: { videoId: video.id },
          fetchOptions: {
            cache: "force-cache",
          },
        });

        if (response.status !== 200) continue;

        analyticsData[video.id] = response.body.count || 0;
      }
      setAnalytics(analyticsData);
    };

    fetchAnalytics();
  }, [data]);

  const deleteCap = async (videoId: string) => {
    if (
      !window.confirm(
        "Are you sure you want to delete this Cap? It cannot be undone."
      )
    ) {
      return;
    }

    const response = await apiClient.video.delete({ query: { videoId } });

    if (response.status === 200) {
      refresh();
      toast.success("Cap deleted successfully");
    } else {
      toast.error("Failed to delete Cap - please try again later");
    }
  };

  if (data.length === 0) {
    return <EmptyCapState />;
  }

  return (
    <div className="flex flex-col w-full">
      <div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {data.map((cap) => (
          <CapCard
            key={cap.id}
            cap={cap}
            analytics={analytics[cap.id] || 0}
            onDelete={deleteCap}
            userId={user?.id}
            userSpaces={userSpaces}
          />
        ))}
      </div>
      {(data.length > limit || data.length === limit || page !== 1) && (
        <div className="mt-10">
          <CapPagination currentPage={page} totalPages={totalPages} />
        </div>
      )}
    </div>
  );
};
