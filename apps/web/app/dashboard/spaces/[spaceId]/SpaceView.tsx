"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@cap/ui";
import { CapCard } from "@/app/dashboard/caps/components/CapCard";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";
import { EmptyState } from "@/components/EmptyState";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faUsers, faUserGear } from "@fortawesome/free-solid-svg-icons";
import { toast } from "react-hot-toast";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { getSpace, getSpaceCaps, removeCapFromSpace } from "./actions";

interface Space {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  organizationId: string;
  createdById: string;
}

interface SpaceCap {
  id: string;
  ownerId: string;
  name: string;
  createdAt: Date;
  totalComments: number;
  totalReactions: number;
  ownerName: string | null;
}

export function SpaceView({ spaceId }: { spaceId: string }) {
  const router = useRouter();
  const { activeOrganization, user } = useSharedContext();

  // Fetch space data
  const { data: spaceData, isLoading: isLoadingSpace } = useQuery({
    queryKey: ["space", spaceId],
    queryFn: async () => {
      const response = await getSpace(spaceId);
      if (!response.success) {
        throw new Error(response.error || "Failed to fetch space");
      }
      return response.space;
    },
  });

  // Fetch caps in this space
  const {
    data: spaceCaps,
    isLoading: isLoadingCaps,
    refetch: refetchCaps,
  } = useQuery({
    queryKey: ["spaceCaps", spaceId],
    queryFn: async () => {
      const response = await getSpaceCaps(spaceId);
      if (!response.success) {
        throw new Error(response.error || "Failed to fetch caps");
      }
      return response.caps;
    },
    enabled: !!spaceData, // Only fetch caps when space data is available
  });

  // Delete cap mutation
  const deleteCapMutation = useMutation({
    mutationFn: async (capId: string) => {
      const response = await removeCapFromSpace(capId, spaceId);
      if (!response.success) {
        throw new Error(response.error || "Failed to remove cap");
      }
      return response;
    },
    onSuccess: () => {
      toast.success("Cap removed from space");
      refetchCaps(); // Refresh cap list after deletion
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to remove cap"
      );
    },
  });

  const handleDeleteCap = async (capId: string) => {
    if (confirm("Are you sure you want to remove this cap from the space?")) {
      deleteCapMutation.mutate(capId);
    }
  };

  const isLoading = isLoadingSpace || isLoadingCaps;

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-full">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-10"></div>
      </div>
    );
  }

  if (!spaceData) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <h1 className="text-xl font-medium text-gray-12">Space not found</h1>
        <p className="text-gray-10 mt-2">
          The space you're looking for doesn't exist or you don't have access.
        </p>
        <Button className="mt-4" onClick={() => router.push("/dashboard/caps")}>
          Go to My Caps
        </Button>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center">
          <Avatar
            letterClass="text-gray-1 text-xl"
            className="relative flex-shrink-0 size-12 mr-4"
            name={spaceData.name}
          />
          <div>
            <h1 className="text-2xl font-semibold text-gray-12">
              {spaceData.name}
            </h1>
            {spaceData.description && (
              <p className="text-gray-10 mt-1">{spaceData.description}</p>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="gray"
            className="flex items-center gap-2"
            onClick={() => {
              // This would open a dialog to manage space members
              toast.success("Space members management coming soon");
            }}
          >
            <FontAwesomeIcon icon={faUsers} className="size-4" />
            <span>Members</span>
          </Button>
          <Button
            variant="gray"
            className="flex items-center gap-2"
            onClick={() => {
              // This would open space settings
              toast.success("Space settings coming soon");
            }}
          >
            <FontAwesomeIcon icon={faUserGear} className="size-4" />
            <span>Settings</span>
          </Button>
        </div>
      </div>

      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-medium text-gray-12">Caps in this space</h2>
        <Button
          className="flex items-center gap-2"
          onClick={() => {
            // This would open a dialog to add caps to the space
            toast.success("Add caps coming soon");
          }}
        >
          <FontAwesomeIcon icon={faPlus} className="size-4" />
          <span>Add Caps</span>
        </Button>
      </div>

      {!spaceCaps || spaceCaps.length === 0 ? (
        <EmptyState
          title="No caps in this space yet"
          description="Add caps to this space to organize your content."
          actionLabel="Add Caps"
          onAction={() => {
            toast.success("Add caps coming soon");
          }}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {spaceCaps.map((cap) => (
            <CapCard
              key={cap.id}
              cap={{
                ...cap,
                ownerName: cap.ownerName || null,
              }}
              analytics={0}
              onDelete={() => handleDeleteCap(cap.id)}
              userId={user?.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
