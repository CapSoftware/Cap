"use client";

import { getVideoAnalytics } from "@/actions/videos/get-analytics";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { VideoMetadata } from "@cap/database/types";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CapPagination } from "../caps/components/CapPagination";
import { EmptySharedCapState } from "./components/EmptySharedCapState";
import { SharedCapCard } from "./components/SharedCapCard";

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
  activeOrganizationId,
}: {
  data: SharedVideoData;
  count: number;
  activeOrganizationId: string;
}) => {
  const params = useSearchParams();
  const page = Number(params.get("page")) || 1;
  const [analytics, setAnalytics] = useState<Record<string, number>>({});
  const { activeOrganization } = useSharedContext();
  const limit = 15;
  const totalPages = Math.ceil(count / limit);

  useEffect(() => {
    const fetchAnalytics = async () => {
      const analyticsData: Record<string, number> = {};

      for (const video of data) {
        const result = await getVideoAnalytics(video.id);
        analyticsData[video.id] = result.count || 0;
      }
      setAnalytics(analyticsData);
    };

    fetchAnalytics();
  }, [data]);

  if (data.length === 0) {
    return (
      <EmptySharedCapState
        organizationName={activeOrganization?.organization.name || ""}
      />
    );
  }

  return (
    <div className="flex flex-col w-full h-full">
      <div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {data.map((cap) => (
          <SharedCapCard
            key={cap.id}
            cap={cap}
            analytics={analytics[cap.id] || 0}
            organizationName={activeOrganization?.organization.name || ""}
          />
        ))}
      </div>
      {(data.length > limit || data.length === limit || page !== 1) && (
        <div className="mt-4">
          <CapPagination currentPage={page} totalPages={totalPages} />
        </div>
      )}
    </div>
  );
};
