"use client";

import { VideoMetadata } from "@cap/database/types";
import { useSearchParams, useRouter } from "next/navigation";
import { useState } from "react";
import { CapPagination } from "../../caps/components/CapPagination";
import { SharedCapCard } from "./components/SharedCapCard";
import { MembersIndicator } from "./components/MembersIndicator";
import { AddVideosDialog } from "./components/AddVideosDialog";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  OrganizationIndicator,
  OrganizationMemberData,
} from "./components/OrganizationIndicator";
import { AddVideosToOrganizationDialog } from "./components/AddVideosToOrganizationDialog";
import { SpaceMemberData } from "./page";
import { useDashboardContext } from "../../Contexts";
import { FolderDataType } from "../../caps/components/Folder";
import { EmptySharedCapState } from "./components/EmptySharedCapState";
import { NewFolderDialog } from "../../caps/components/NewFolderDialog";
import { Button } from "@cap/ui";
import { faFolderPlus, faInfoCircle } from "@fortawesome/free-solid-svg-icons";
import Folder from "../../caps/components/Folder";
import { useSuspenseQuery } from "@tanstack/react-query";

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

export const SharedCaps = ({
  data,
  count,
  spaceData,
  spaceMembers,
  organizationMembers,
  currentUserId,
  folders,
  dubApiKeyEnabled,
  organizationData,
}: {
  data: SharedVideoData;
  count: number;
  dubApiKeyEnabled: boolean;
  spaceData?: SpaceData;
  hideSharedWith?: boolean;
  spaceMembers?: SpaceMemberData[];
  organizationMembers?: OrganizationMemberData[];
  currentUserId?: string;
  folders?: FolderDataType[];
  organizationData?: {
    id: string;
    name: string;
    ownerId: string;
  };
}) => {
  const params = useSearchParams();
  const router = useRouter();
  const page = Number(params.get("page")) || 1;
  const { activeOrganization } = useDashboardContext();
  const limit = 15;
  const [openNewFolderDialog, setOpenNewFolderDialog] = useState(false);
  const totalPages = Math.ceil(count / limit);
  const [isDraggingCap, setIsDraggingCap] = useState({
    isOwner: false,
    isDragging: false,
  });
  const [isAddVideosDialogOpen, setIsAddVideosDialogOpen] = useState(false);
  const [
    isAddOrganizationVideosDialogOpen,
    setIsAddOrganizationVideosDialogOpen,
  ] = useState(false);

  const isSpaceOwner = spaceData?.createdById === currentUserId;
  const isOrgOwner = organizationData?.ownerId === currentUserId;

  const spaceMemberCount = spaceMembers?.length || 0;

  const organizationMemberCount = organizationMembers?.length || 0;

  const { data: analyticsData } = useSuspenseQuery({
    queryKey: ['analytics', data.map(video => video.id)],
    queryFn: async () => {
      if (!dubApiKeyEnabled || data.length === 0) {
        return {};
      }

      const analyticsPromises = data.map(async (video) => {
        try {
          const response = await fetch(`/api/analytics?videoId=${video.id}`, {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
            },
          });

          if (response.ok) {
            const responseData = await response.json();
            return { videoId: video.id, count: responseData.count || 0 };
          }
          return { videoId: video.id, count: 0 };
        } catch (error) {
          console.warn(`Failed to fetch analytics for video ${video.id}:`, error);
          return { videoId: video.id, count: 0 };
        }
      });

      const results = await Promise.allSettled(analyticsPromises);
      const analyticsData: Record<string, number> = {};

      results.forEach((result) => {
        if (result.status === 'fulfilled' && result.value) {
          analyticsData[result.value.videoId] = result.value.count;
        }
      });

      return analyticsData;
    },
    staleTime: 30000, // 30 seconds
    refetchOnWindowFocus: false,
  });

  const analytics = analyticsData || {};

  const handleVideosAdded = () => {
    router.refresh();
  };

  if (data.length === 0 && folders?.length === 0) {
    return (
      <div className="flex relative flex-col w-full h-full">
        {spaceData && spaceMembers && (
          <MembersIndicator
            memberCount={spaceMemberCount}
            members={spaceMembers}
            organizationMembers={organizationMembers || []}
            spaceId={spaceData.id}
            canManageMembers={isSpaceOwner}
            onAddVideos={() => setIsAddVideosDialogOpen(true)}
          />
        )}
        {organizationData && organizationMembers && !spaceData && (
          <OrganizationIndicator
            memberCount={organizationMemberCount}
            members={organizationMembers}
            organizationName={organizationData.name}
            canManageMembers={isOrgOwner}
            onAddVideos={() => setIsAddOrganizationVideosDialogOpen(true)}
          />
        )}
        <EmptySharedCapState
          organizationName={activeOrganization?.organization.name || ""}
          type={spaceData ? "space" : "organization"}
          spaceData={spaceData}
          currentUserId={currentUserId}
          onAddVideos={
            spaceData
              ? () => setIsAddVideosDialogOpen(true)
              : () => setIsAddOrganizationVideosDialogOpen(true)
          }
        />
        {spaceData && (
          <AddVideosDialog
            open={isAddVideosDialogOpen}
            onClose={() => setIsAddVideosDialogOpen(false)}
            spaceId={spaceData.id}
            spaceName={spaceData.name}
            onVideosAdded={handleVideosAdded}
          />
        )}
        {organizationData && (
          <AddVideosToOrganizationDialog
            open={isAddOrganizationVideosDialogOpen}
            onClose={() => setIsAddOrganizationVideosDialogOpen(false)}
            organizationId={organizationData.id}
            organizationName={organizationData.name}
            onVideosAdded={handleVideosAdded}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex relative flex-col w-full h-full">
      {isDraggingCap.isDragging && (
        <div className="fixed inset-0 z-50 pointer-events-none">
          <div className="flex justify-center items-center w-full h-full">
            <div className="flex gap-2 items-center px-5 py-3 text-sm font-medium text-white rounded-xl bg-blue-12">
              <FontAwesomeIcon
                className="size-3.5 text-white opacity-50"
                icon={faInfoCircle}
              />
              <p className="text-white">
                {isDraggingCap.isOwner ? " Drag to a space to share or folder to move" : "Only the video owner can drag and move the video"}
              </p>
            </div>
          </div>
        </div>
      )}
      <NewFolderDialog
        open={openNewFolderDialog}
        spaceId={spaceData?.id ?? activeOrganization?.organization.id}
        onOpenChange={setOpenNewFolderDialog}
      />
      <div className="flex flex-wrap gap-3 mb-10">
        {spaceData && spaceMembers && (
          <MembersIndicator
            memberCount={spaceMemberCount}
            members={spaceMembers}
            organizationMembers={organizationMembers || []}
            spaceId={spaceData.id}
            canManageMembers={isSpaceOwner}
            onAddVideos={() => setIsAddVideosDialogOpen(true)}
          />
        )}
        {organizationData && organizationMembers && !spaceData && (
          <OrganizationIndicator
            memberCount={organizationMemberCount}
            members={organizationMembers}
            organizationName={organizationData.name}
            canManageMembers={isOrgOwner}
            onAddVideos={() => setIsAddOrganizationVideosDialogOpen(true)}
          />
        )}
        {spaceData && (
          <AddVideosDialog
            open={isAddVideosDialogOpen}
            onClose={() => setIsAddVideosDialogOpen(false)}
            spaceId={spaceData.id}
            spaceName={spaceData.name}
            onVideosAdded={handleVideosAdded}
          />
        )}
        {organizationData && (
          <AddVideosToOrganizationDialog
            open={isAddOrganizationVideosDialogOpen}
            onClose={() => setIsAddOrganizationVideosDialogOpen(false)}
            organizationId={organizationData.id}
            organizationName={organizationData.name}
            onVideosAdded={handleVideosAdded}
          />
        )}
        <Button
          onClick={() => setOpenNewFolderDialog(true)}
          size="sm"
          variant="dark"
          className="flex gap-2 items-center w-fit"
        >
          <FontAwesomeIcon className="size-3.5" icon={faFolderPlus} />
          New Folder
        </Button>
      </div>
      {folders && folders.length > 0 && (
        <>
          <h1 className="mb-6 text-2xl font-medium text-gray-12">Folders</h1>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4 mb-10">
            {folders.map((folder) => (
              <Folder key={folder.id} {...folder} />
            ))}
          </div>
        </>
      )}

      <h1 className="mb-4 text-2xl font-medium text-gray-12">Videos</h1>
      <div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {data.map((cap) => {
          const isOwner = cap.ownerId === currentUserId;
          return (
            <SharedCapCard
              key={cap.id}
              cap={cap}
              hideSharedStatus
              analytics={analytics[cap.id] || 0}
              organizationName={activeOrganization?.organization.name || ""}
              spaceName={spaceData?.name || ""}
              userId={currentUserId}
              onDragStart={() => setIsDraggingCap({ isOwner, isDragging: true })}
              onDragEnd={() => setIsDraggingCap({ isOwner, isDragging: false })}
            />
          );
        })}
      </div>
      {(data.length > limit || data.length === limit || page !== 1) && (
        <div className="mt-4">
          <CapPagination currentPage={page} totalPages={totalPages} />
        </div>
      )}
    </div>
  );
};
