"use client";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { apiClient } from "@/utils/web-api";
import { VideoMetadata } from "@cap/database/types";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { CapCard, CapCardProps } from "./components/CapCard";
import { CapPagination } from "./components/CapPagination";
import { EmptyCapState } from "./components/EmptyCapState";
import { Button } from "@cap/ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { deleteVideo } from "@/actions/videos/delete";

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
  const [selectedCaps, setSelectedCaps] = useState<string[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);

  const anyCapSelected = selectedCaps.length > 0;

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

  const toggleCapSelection = (capId: string) => {
    setSelectedCaps((prevSelected) =>
      prevSelected.includes(capId)
        ? prevSelected.filter((id) => id !== capId)
        : [...prevSelected, capId]
    );
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

    const loadingToast = toast.loading(
      `Deleting ${selectedCaps.length} cap${
        selectedCaps.length === 1 ? "" : "s"
      }...`
    );

    try {
      const results = await Promise.allSettled(
        selectedCaps.map((capId) => deleteVideo(capId))
      );

      toast.dismiss(loadingToast);

      const successCount = results.filter(
        (result) => result.status === "fulfilled" && result.value.success
      ).length;

      const errorCount = selectedCaps.length - successCount;

      if (successCount > 0) {
        toast.success(
          `Successfully deleted ${successCount} cap${
            successCount === 1 ? "" : "s"
          }`
        );
      }

      if (errorCount > 0) {
        toast.error(
          `Failed to delete ${errorCount} cap${errorCount === 1 ? "" : "s"}`
        );
      }

      setSelectedCaps([]);
      refresh();
    } catch (error) {
      toast.dismiss(loadingToast);
      toast.error("An error occurred while deleting caps");
    } finally {
      setIsDeleting(false);
    }
  };

  if (data.length === 0) {
    return <EmptyCapState />;
  }

  return (
    <div className="flex flex-col w-full relative">
      <div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {data.map((cap) => (
          <CapCard
            key={cap.id}
            cap={cap}
            analytics={analytics[cap.id] || 0}
            onDelete={deleteCap}
            userId={user?.id}
            userSpaces={userSpaces}
            isSelected={selectedCaps.includes(cap.id)}
            onSelectToggle={() => toggleCapSelection(cap.id)}
            anyCapSelected={anyCapSelected}
          />
        ))}
      </div>
      {(data.length > limit || data.length === limit || page !== 1) && (
        <div className="mt-10">
          <CapPagination currentPage={page} totalPages={totalPages} />
        </div>
      )}

      {selectedCaps.length > 0 && (
        <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 bg-white shadow-lg rounded-xl border border-gray-200 px-6 py-4 flex justify-between items-center z-50 w-full max-w-xl mx-auto">
          <div className="text-sm font-medium text-gray-400">
            {selectedCaps.length} cap{selectedCaps.length !== 1 ? "s" : ""}{" "}
            selected
          </div>
          <div className="flex gap-2 ml-4">
            <Button
              style={{ minWidth: "auto" }}
              variant="destructive"
              onClick={deleteSelectedCaps}
              disabled={isDeleting}
              className="text-sm w-[50px]"
              spinner={isDeleting}
              size="sm"
            >
              <FontAwesomeIcon icon={faTrash} />
            </Button>
            <Button
              variant="white"
              onClick={() => setSelectedCaps([])}
              className="text-sm"
              size="sm"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
