"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { SharedCapCard } from "./components/SharedCapCard";
import { EmptySharedCapState } from "./components/EmptySharedCapState";
import { CapPagination } from "../caps/components/CapPagination";
import { VideoMetadata } from "@cap/database/types";

type SharedVideoData = {
  id: string;
  ownerId: string;
  name: string;
  createdAt: Date;
  totalComments: number;
  totalReactions: number;
  ownerName: string | null;
  metadata?: VideoMetadata;
}[];

export const SharedCaps = ({
  data,
  count,
  activeSpaceId,
}: {
  data: SharedVideoData;
  count: number;
  activeSpaceId: string;
}) => {
  const { refresh } = useRouter();
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

  return (
    <div className="flex flex-col min-h-[calc(100vh-30px)] h-full">
      <div className="mb-3">
        <h1 className="text-3xl font-medium">Shared Caps</h1>
      </div>
      <div className="flex-grow flex inner">
        {data.length === 0 ? (
          <EmptySharedCapState spaceName={activeSpace?.space.name || ""} />
        ) : (
          <div className="flex flex-col w-full h-full">
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
              {data.map((cap) => (
                <SharedCapCard
                  key={cap.id}
                  cap={cap}
                  analytics={analytics[cap.id] || 0}
                  spaceName={activeSpace?.space.name || ""}
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
