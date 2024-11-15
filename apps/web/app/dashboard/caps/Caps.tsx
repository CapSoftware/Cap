"use client";
import { useRouter, useSearchParams } from "next/navigation";
import toast from "react-hot-toast";
import { useEffect, useState } from "react";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { CapCard } from "./components/CapCard";
import { EmptyCapState } from "./components/EmptyCapState";
import { CapPagination } from "./components/CapPagination";

type VideoData = {
  id: string;
  ownerId: string;
  name: string;
  createdAt: Date;
  totalComments: number;
  totalReactions: number;
  sharedSpaces: { id: string; name: string }[];
  ownerName: string;
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
  const { refresh, replace } = useRouter();
  const params = useSearchParams();
  const page = Number(params.get("page")) || 1;
  const [analytics, setAnalytics] = useState<Record<string, number>>({});
  const { user, activeSpace } = useSharedContext();
  const limit = 15;
  const totalPages = Math.ceil(count / limit);

  useEffect(() => {
    const fetchAnalytics = async () => {
      const analyticsData: Record<string, number> = {};

      for (const video of data) {
        const response = await fetch(
          `/api/video/analytics?videoId=${video.id}`,
          {
            cache: "force-cache",
          }
        );
        const data = await response.json();

        analyticsData[video.id] = data.count || 0;
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

    const response = await fetch(`/api/video/delete?videoId=${videoId}`, {
      method: "DELETE",
    });

    if (response.ok) {
      refresh();
      toast.success("Cap deleted successfully");
    } else {
      toast.error("Failed to delete Cap - please try again later");
    }
  };

  return (
    <div className="flex flex-col min-h-[calc(100vh-30px)] h-full">
      <div className="mb-3">
        <h1 className="text-3xl font-medium">My Caps</h1>
      </div>
      <div className="flex-grow flex inner">
        {data.length === 0 ? (
          <EmptyCapState userName={user?.name || ""} />
        ) : (
          <div className="flex flex-col w-full h-full">
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
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
              <div className="mt-4">
                <CapPagination currentPage={page} totalPages={totalPages} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
