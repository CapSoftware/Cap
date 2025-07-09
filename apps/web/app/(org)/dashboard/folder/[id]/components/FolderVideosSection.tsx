"use client";

import { UploadPlaceholderCard } from "../../../caps/components/UploadPlaceholderCard";
import { ClientCapCard } from "./index";
import { useRouter } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { deleteVideo } from "@/actions/videos/delete";
import { SelectedCapsBar } from "../../../caps/components/SelectedCapsBar";
import { useApiClient } from "@/utils/web-api";
import { useUploadingContext } from "../../../caps/UploadingContext";
import { type VideoData } from "../../../caps/Caps";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { SharedCapCard } from "../../../spaces/[spaceId]/components/SharedCapCard";

interface FolderVideosSectionProps {
  initialVideos: VideoData;
  dubApiKeyEnabled: boolean;
  cardType?: "shared" | "default";
  userId?: string;
}

export default function FolderVideosSection({
  initialVideos,
  dubApiKeyEnabled,
  cardType = "default",
  userId,
}: FolderVideosSectionProps) {
  const router = useRouter();
  const apiClient = useApiClient();
  const { isUploading } = useUploadingContext();
  const { activeOrganization } = useDashboardContext();

  const [selectedCaps, setSelectedCaps] = useState<string[]>([]);
  const previousCountRef = useRef<number>(0);
  const [analytics, setAnalytics] = useState<Record<string, number>>({});

  const [isDeleting, setIsDeleting] = useState(false);

  const deleteSelectedCaps = async () => {
    if (selectedCaps.length === 0) return;

    setIsDeleting(true);

    try {
      toast.promise(
        async () => {
          const results = await Promise.allSettled(
            selectedCaps.map((capId) => deleteVideo(capId))
          );

          const successCount = results.filter(
            (result) => result.status === "fulfilled" && result.value.success
          ).length;

          const errorCount = selectedCaps.length - successCount;

          if (successCount > 0 && errorCount > 0) {
            return { success: successCount, error: errorCount };
          } else if (successCount > 0) {
            return { success: successCount };
          } else {
            throw new Error(
              `Failed to delete ${errorCount} cap${errorCount === 1 ? "" : "s"}`
            );
          }
        },
        {
          loading: `Deleting ${selectedCaps.length} cap${selectedCaps.length === 1 ? "" : "s"
            }...`,
          success: (data) => {
            if (data.error) {
              return `Successfully deleted ${data.success} cap${data.success === 1 ? "" : "s"
                }, but failed to delete ${data.error} cap${data.error === 1 ? "" : "s"
                }`;
            }
            return `Successfully deleted ${data.success} cap${data.success === 1 ? "" : "s"
              }`;
          },
          error: (error) =>
            error.message || "An error occurred while deleting caps",
        }
      );

      setSelectedCaps([]);
      router.refresh();
    } catch (error) {
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCapSelection = (capId: string) => {
    setSelectedCaps((prev) => {
      const newSelection = prev.includes(capId)
        ? prev.filter((id) => id !== capId)
        : [...prev, capId];

      previousCountRef.current = prev.length;

      return newSelection;
    });
  };

  useEffect(() => {
    const fetchAnalytics = async () => {
      if (!dubApiKeyEnabled) return;

      const analyticsData: Record<string, number> = {};
      for (const video of initialVideos) {
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
  }, [initialVideos]);

  return (
    <>
      <div className="flex justify-between items-center mb-6 w-full">
        <h1 className="text-2xl font-medium text-gray-12">Videos</h1>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {initialVideos.length === 0 && !isUploading ? (
          <p className="col-span-full text-gray-9">
            No videos in this folder yet. Drag and drop into the folder or
            upload.
          </p>
        ) : (
          <>
            {isUploading && (
              <UploadPlaceholderCard key={"upload-placeholder"} />
            )}

            {cardType === "shared" ? (
              initialVideos.map((video) => (
                <SharedCapCard
                  key={video.id}
                  cap={video}
                  hideSharedStatus
                  analytics={analytics[video.id] || 0}
                  organizationName={activeOrganization?.organization.name || ""}
                  userId={userId}
                />
              ))
            ) : (
              initialVideos.map((video) => (
                <ClientCapCard
                  key={video.id}
                  videoId={video.id}
                  cap={video}
                  analytics={analytics[video.id] || 0}
                  isSelected={selectedCaps.includes(video.id)}
                  anyCapSelected={selectedCaps.length > 0}
                  isDeleting={isDeleting}
                  onSelectToggle={() => handleCapSelection(video.id)}
                  onDelete={deleteSelectedCaps}
                />
              ))
            )}
          </>
        )}
      </div>
      <SelectedCapsBar
        selectedCaps={selectedCaps}
        setSelectedCaps={setSelectedCaps}
        deleteSelectedCaps={deleteSelectedCaps}
        isDeleting={isDeleting}
      />
    </>
  );
}
