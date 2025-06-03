"use client";
import { deleteVideo } from "@/actions/videos/delete";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { useApiClient } from "@/utils/web-api";
import { VideoMetadata } from "@cap/database/types";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CapCard } from "./components/CapCard";
import { CapPagination } from "./components/CapPagination";
import { EmptyCapState } from "./components/EmptyCapState";
import { SelectedCapsBar } from "./components/SelectedCapsBar";
import { UploadCapButton } from "./components/UploadCapButton";
import { UploadPlaceholderCard } from "./components/UploadPlaceholderCard";
import { serverEnv } from "@cap/env";

type VideoData = {
  id: string;
  ownerId: string;
  name: string;
  createdAt: Date;
  totalComments: number;
  totalReactions: number;
  sharedOrganizations: { id: string; name: string; iconUrl?: string }[];
  sharedSpaces: {
    id: string;
    name: string;
    iconUrl?: string;
    organizationId: string;
  }[];
  ownerName: string;
  metadata?: VideoMetadata;
  hasPassword: boolean;
}[];

export const Caps = ({
  data,
  count,
  dubApiKeyEnabled,
}: {
  data: VideoData;
  count: number;
  dubApiKeyEnabled: boolean;
}) => {
  const { refresh } = useRouter();
  const params = useSearchParams();
  const page = Number(params.get("page")) || 1;
  const [analytics, setAnalytics] = useState<Record<string, number>>({});
  const { user, spacesData, organizationData } = useSharedContext();
  const limit = 15;
  const totalPages = Math.ceil(count / limit);
  const [selectedCaps, setSelectedCaps] = useState<string[]>([]);
  const previousCountRef = useRef<number>(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDraggingCap, setIsDraggingCap] = useState(false);
  const [uploadPlaceholders, setUploadPlaceholders] = useState<
    {
      id: string;
      progress: number;
      thumbnail?: string;
      uploadProgress?: number;
    }[]
  >([]);

  const anyCapSelected = selectedCaps.length > 0;

  const apiClient = useApiClient();

  useEffect(() => {
    const fetchAnalytics = async () => {
      if (!dubApiKeyEnabled) return;

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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedCaps.length > 0) {
        setSelectedCaps([]);
      }

      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedCaps.length > 0
      ) {
        if (e.key === "Backspace") {
          e.preventDefault();
        }

        if (
          !["INPUT", "TEXTAREA", "SELECT"].includes(
            document.activeElement?.tagName || ""
          )
        ) {
          deleteSelectedCaps();
        }
      }

      if (e.key === "a" && (e.ctrlKey || e.metaKey) && data.length > 0) {
        if (
          !["INPUT", "TEXTAREA", "SELECT"].includes(
            document.activeElement?.tagName || ""
          )
        ) {
          e.preventDefault();
          setSelectedCaps(data.map((cap) => cap.id));
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedCaps.length, data]);

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

  const deleteCap = async (videoId: string) => {
    if (
      !window.confirm(
        "Are you sure you want to delete this Cap? It cannot be undone."
      )
    ) {
      return;
    }

    const response = await deleteVideo(videoId);

    if (response.success) {
      refresh();
      toast.success("Cap deleted successfully");
    } else {
      toast.error(
        response.message || "Failed to delete Cap - please try again later"
      );
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

  const deleteSelectedCaps = async () => {
    if (selectedCaps.length === 0) return;

    if (
      !window.confirm(
        `Are you sure you want to delete ${selectedCaps.length} cap${
          selectedCaps.length === 1 ? "" : "s"
        }? This cannot be undone.`
      )
    ) {
      return;
    }

    setIsDeleting(true);

    try {
      await toast.promise(
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
          loading: `Deleting ${selectedCaps.length} cap${
            selectedCaps.length === 1 ? "" : "s"
          }...`,
          success: (data) => {
            if (data.error) {
              return `Successfully deleted ${data.success} cap${
                data.success === 1 ? "" : "s"
              }, but failed to delete ${data.error} cap${
                data.error === 1 ? "" : "s"
              }`;
            }
            return `Successfully deleted ${data.success} cap${
              data.success === 1 ? "" : "s"
            }`;
          },
          error: (error) =>
            error.message || "An error occurred while deleting caps",
        }
      );

      setSelectedCaps([]);
      refresh();
    } catch (error) {
    } finally {
      setIsDeleting(false);
    }
  };

  const handleUploadStart = (id: string, thumbnail?: string) => {
    setUploadPlaceholders((prev) => [{ id, progress: 0, thumbnail }, ...prev]);
  };

  const handleUploadProgress = (
    id: string,
    progress: number,
    uploadProgress?: number
  ) => {
    setUploadPlaceholders((prev) =>
      prev.map((u) => (u.id === id ? { ...u, progress, uploadProgress } : u))
    );
  };

  const handleUploadComplete = (id: string) => {
    setUploadPlaceholders((prev) => prev.filter((u) => u.id !== id));
    refresh();
  };

  if (data.length === 0) {
    return <EmptyCapState />;
  }

  return (
    <div className="flex relative flex-col w-full">
      {isDraggingCap && (
        <div className="fixed inset-0 z-50 pointer-events-none">
          <div className="flex justify-center items-center w-full h-full">
            <div className="px-5 py-3 text-sm font-medium rounded-lg border backdrop-blur-md bg-gray-1/80 border-gray-4 text-gray-12">
              Drag to a space to share
            </div>
          </div>
        </div>
      )}
      <div className="flex justify-end mb-4">
        <UploadCapButton
          onStart={handleUploadStart}
          onProgress={handleUploadProgress}
          onComplete={handleUploadComplete}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {uploadPlaceholders.map((u) => (
          <UploadPlaceholderCard
            key={u.id}
            thumbnail={u.thumbnail}
            progress={u.progress}
            uploadProgress={u.uploadProgress}
          />
        ))}
        {data.map((cap) => (
          <CapCard
            key={cap.id}
            cap={cap}
            analytics={analytics[cap.id] || 0}
            onDelete={deleteCap}
            userId={user?.id}
            isSelected={selectedCaps.includes(cap.id)}
            onSelectToggle={() => handleCapSelection(cap.id)}
            anyCapSelected={anyCapSelected}
          />
        ))}
      </div>
      {(data.length > limit || data.length === limit || page !== 1) && (
        <div className="mt-10">
          <CapPagination currentPage={page} totalPages={totalPages} />
        </div>
      )}

      <SelectedCapsBar
        selectedCaps={selectedCaps}
        setSelectedCaps={setSelectedCaps}
        deleteSelectedCaps={deleteSelectedCaps}
        isDeleting={isDeleting}
      />
    </div>
  );
};
