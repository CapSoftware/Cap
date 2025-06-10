"use client";

import { getVideoAnalytics } from "@/actions/videos/get-analytics";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { VideoMetadata } from "@cap/database/types";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CapPagination } from "../../caps/components/CapPagination";
import { EmptySharedCapState } from "./components/EmptySharedCapState";
import { SharedCapCard } from "./components/SharedCapCard";
import { MembersIndicator } from "./components/MembersIndicator";

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

type SpaceData = {
  id: string;
  name: string;
  organizationId: string;
  createdById: string;
};

type SpaceMemberData = {
  id: string;
  userId: string;
  name: string | null;
  email: string;
};

export const SharedCaps = ({
  data,
  count,
  spaceData,
  hideSharedWith,
  spaceMembers,
  organizationMembers,
  currentUserId,
}: {
  data: SharedVideoData;
  count: number;
  spaceData?: SpaceData;
  hideSharedWith?: boolean;
  spaceMembers?: SpaceMemberData[];
  organizationMembers?: SpaceMemberData[];
  currentUserId?: string;
}) => {
  const params = useSearchParams();
  const page = Number(params.get("page")) || 1;
  const [analytics, setAnalytics] = useState<Record<string, number>>({});
  const { activeOrganization } = useSharedContext();
  const limit = 15;
  const totalPages = Math.ceil(count / limit);
  const [isDraggingCap, setIsDraggingCap] = useState(false);

  const isSpaceOwner = spaceData?.createdById === currentUserId;

  const spaceMemberCount = isSpaceOwner
    ? spaceMembers?.filter((m) => m.userId !== currentUserId).length || 0
    : spaceMembers?.length || 0;

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

  useEffect(() => {
    const handleDragStart = () => setIsDraggingCap(true);
    const handleDragEnd = () => setIsDraggingCap(false);

    window.addEventListener("dragstart", handleDragStart);
    window.addEventListener("dragend", handleDragEnd);

    return () => {
      window.removeEventListener("dragstart", handleDragStart);
      window.removeEventListener("dragend", handleDragEnd);
    };
  }, []);

  if (data.length === 0) {
    return (
      <div className="flex relative flex-col w-full h-full">
        {spaceData && spaceMembers && (
          <MembersIndicator
            memberCount={spaceMemberCount}
            members={spaceMembers}
            organizationMembers={organizationMembers || []}
            spaceId={spaceData.id}
            canManageMembers={isSpaceOwner}
          />
        )}
        <EmptySharedCapState
          organizationName={activeOrganization?.organization.name || ""}
          type="space"
        />
      </div>
    );
  }

  return (
    <div className="flex relative flex-col w-full h-full">
      {isDraggingCap && (
        <div className="fixed inset-0 z-50 pointer-events-none">
          <div className="flex justify-center items-center w-full h-full">
            <div className="px-5 py-3 text-sm font-medium rounded-lg border backdrop-blur-md bg-gray-1/80 border-gray-4 text-gray-12">
              Drag to a space to share
            </div>
          </div>
        </div>
      )}
      {spaceData && spaceMembers && (
        <MembersIndicator
          memberCount={spaceMemberCount}
          members={spaceMembers}
          organizationMembers={organizationMembers || []}
          spaceId={spaceData.id}
          canManageMembers={isSpaceOwner}
        />
      )}
      <div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {data.map((cap) => (
          <SharedCapCard
            key={cap.id}
            cap={cap}
            analytics={analytics[cap.id] || 0}
            organizationName={activeOrganization?.organization.name || ""}
            userId={currentUserId}
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
