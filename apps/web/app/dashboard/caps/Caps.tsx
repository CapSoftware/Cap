"use client";
import { deleteVideo } from "@/actions/videos/delete";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { apiClient } from "@/utils/web-api";
import { VideoMetadata } from "@cap/database/types";
import { Button } from "@cap/ui";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AnimatePresence, motion } from "framer-motion";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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
  sharedOrganizations: { id: string; name: string }[];
  ownerName: string;
  metadata?: VideoMetadata;
}[];

export const Caps = ({
  data,
  count,
  userOrganizations,
}: {
  data: VideoData;
  count: number;
  userOrganizations: { id: string; name: string }[];
}) => {
  const { refresh } = useRouter();
  const params = useSearchParams();
  const page = Number(params.get("page")) || 1;
  const [analytics, setAnalytics] = useState<Record<string, number>>({});
  const { user } = useSharedContext();
  const limit = 15;
  const totalPages = Math.ceil(count / limit);
  const [selectedCaps, setSelectedCaps] = useState<string[]>([]);
  const previousCountRef = useRef<number>(0);
  const [animateDirection, setAnimateDirection] = useState<"up" | "down">("up");
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
          setAnimateDirection("up");
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedCaps.length, data]);

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
      setAnimateDirection(newSelection.length > prev.length ? "up" : "down");

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
    <div className="flex relative flex-col w-full">
      <div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {data.map((cap) => (
          <CapCard
            key={cap.id}
            cap={cap}
            analytics={analytics[cap.id] || 0}
            onDelete={deleteCap}
            userId={user?.id}
            userOrganizations={userOrganizations}
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

      <AnimatePresence>
        {selectedCaps.length > 0 && (
          <motion.div
            className="flex fixed right-0 left-0 bottom-4 z-50 justify-between items-center px-6 py-3 mx-auto w-full max-w-xl rounded-xl border shadow-lg border-gray-3 bg-gray-2"
            initial={{ opacity: 0, y: 10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{
              opacity: 0,
              y: 10,
              scale: 0.9,
              transition: { duration: 0.2 },
            }}
            transition={{
              type: "spring",
              damping: 15,
              stiffness: 200,
            }}
          >
            <div className="flex gap-1 text-sm font-medium text-gray-12">
              <AnimatePresence initial={false} mode="wait">
                <motion.div
                  initial={{
                    opacity: 0,
                    y: animateDirection === "up" ? 10 : -10,
                    scale: 0.9,
                  }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  key={selectedCaps.length}
                  layoutId="selected-caps-count"
                  className="tabular-nums"
                  exit={{
                    opacity: 0,
                    y: animateDirection === "up" ? -10 : 10,
                    scale: 0.9,
                  }}
                  transition={{ duration: 0.1, ease: "easeInOut" }}
                >
                  {selectedCaps.length}
                </motion.div>
              </AnimatePresence>
              cap{selectedCaps.length !== 1 ? "s" : ""} selected
            </div>
            <div className="flex gap-2 ml-4">
              <Button
                variant="dark"
                onClick={() => setSelectedCaps([])}
                className="text-sm"
                size="sm"
              >
                Cancel
              </Button>
              <Button
                style={{ minWidth: "auto" }}
                variant="destructive"
                onClick={deleteSelectedCaps}
                disabled={isDeleting}
                className="text-sm w-[40px]"
                spinner={isDeleting}
                size="sm"
              >
                <FontAwesomeIcon icon={faTrash} />
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
