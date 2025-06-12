"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Button,
  Input,
} from "@cap/ui";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faCheck } from "@fortawesome/free-solid-svg-icons";
import { VideoThumbnail } from "@/components/VideoThumbnail";
import { VideoMetadata } from "@cap/database/types";
import { getUserVideos } from "@/actions/videos/get-user-videos";
import { addVideosToSpace } from "@/actions/spaces/add-videos";
import { getSpaceVideoIds } from "@/actions/spaces/get-space-videos";
import { useMutation, useQuery } from "@tanstack/react-query";
import moment from "moment";
import clsx from "clsx";

interface AddVideosDialogProps {
  open: boolean;
  onClose: () => void;
  spaceId: string;
  spaceName: string;
  onVideosAdded?: () => void;
}

type UserVideo = {
  id: string;
  ownerId: string;
  name: string;
  createdAt: Date;
  totalComments: number;
  totalReactions: number;
  ownerName: string;
  metadata?: VideoMetadata;
};

const formSchema = z.object({
  search: z.string(),
});

export const AddVideosDialog: React.FC<AddVideosDialogProps> = ({
  open,
  onClose,
  spaceId,
  spaceName,
  onVideosAdded,
}) => {
  const [selectedVideos, setSelectedVideos] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      search: "",
    },
  });

  const { data: videosData, isLoading } = useQuery({
    queryKey: ["user-videos"],
    queryFn: async () => {
      const result = await getUserVideos(50);
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    },
    enabled: open,
  });

  const { data: spaceVideoIds } = useQuery({
    queryKey: ["space-video-ids", spaceId],
    queryFn: async () => {
      const result = await getSpaceVideoIds(spaceId);
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    },
    enabled: open,
  });

  const addVideosMutation = useMutation({
    mutationFn: (videoIds: string[]) => addVideosToSpace(spaceId, videoIds),
    onSuccess: (result) => {
      if (result?.success) {
        toast.success(result.message || "Videos added successfully");
        setSelectedVideos([]);
        onVideosAdded?.();
        onClose();
      } else {
        toast.error(result?.error || "Failed to add videos to space");
      }
    },
    onError: (error) => {
      toast.error("Failed to add videos to space");
      console.error("Error adding videos:", error);
    },
  });

  const filteredVideos =
    videosData?.filter((video) =>
      video.name.toLowerCase().includes(searchTerm.toLowerCase())
    ) || [];

  const handleVideoToggle = (videoId: string) => {
    setSelectedVideos((prev) =>
      prev.includes(videoId)
        ? prev.filter((id) => id !== videoId)
        : [...prev, videoId]
    );
  };

  const handleAddVideos = () => {
    if (selectedVideos.length === 0) return;
    addVideosMutation.mutate(selectedVideos);
  };

  useEffect(() => {
    if (!open) {
      setSelectedVideos([]);
      setSearchTerm("");
      form.reset();
    }
  }, [open, form]);

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="p-0 w-full max-w-2xl rounded-xl border bg-white border-gray-200 max-h-[90vh] sm:max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-4 sm:px-8 py-4 sm:py-8 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
            <div className="w-6 h-6 sm:w-8 sm:h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
              <FontAwesomeIcon
                icon={faPlus}
                className="text-blue-600 text-xs sm:text-sm"
              />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg sm:text-xl font-semibold text-gray-900 truncate">
                Add videos to {spaceName}
              </h2>
              <p className="text-xs sm:text-sm text-gray-600 mt-0.5 sm:mt-1 line-clamp-2 sm:line-clamp-none">
                Find and add videos you have previously recorded to share with
                people in this Space.
              </p>
            </div>
          </div>
        </div>

        <div className="px-4 sm:px-8 py-4 sm:py-6 flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="mb-4 sm:mb-6 px-2 flex-shrink-0">
            <Input
              placeholder="Search your videos"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full h-10 sm:h-12 text-sm sm:text-base border-gray-300 rounded-lg focus:border-blue-500 focus:ring-blue-500"
            />
          </div>

          <div className="flex-1 overflow-y-auto min-h-0 px-1">
            {isLoading ? (
              <div className="flex justify-center items-center h-64">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
              </div>
            ) : filteredVideos.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-center">
                <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-4">
                  <svg
                    className="w-8 h-8 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                    />
                  </svg>
                </div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  {searchTerm ? "No videos found" : "No videos to add"}
                </h3>
                <p className="text-gray-600 max-w-sm">
                  {searchTerm
                    ? "Try adjusting your search terms"
                    : "Record some videos first to add them to this space"}
                </p>
              </div>
            ) : (
              <div className="space-y-3 pb-2">
                {filteredVideos.map((video) => (
                  <VideoCard
                    key={video.id}
                    video={video}
                    isSelected={selectedVideos.includes(video.id)}
                    onToggle={() => handleVideoToggle(video.id)}
                    isAlreadyInSpace={
                      spaceVideoIds?.includes(video.id) || false
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-4 sm:px-8 py-4 sm:py-6 border-t border-gray-200 bg-gray-50 flex-shrink-0">
          <div className="text-xs sm:text-sm text-gray-600">
            {selectedVideos.length > 0 && (
              <span>
                {selectedVideos.length} video
                {selectedVideos.length === 1 ? "" : "s"} selected
              </span>
            )}
          </div>
          <div className="flex gap-2 sm:gap-3">
            <Button
              variant="gray"
              size="sm"
              onClick={onClose}
              className="px-3 sm:px-4 py-2 text-sm"
            >
              Cancel
            </Button>
            <Button
              variant="dark"
              size="sm"
              disabled={
                selectedVideos.length === 0 || addVideosMutation.isPending
              }
              spinner={addVideosMutation.isPending}
              onClick={handleAddVideos}
              className="px-3 sm:px-4 py-2 text-sm"
            >
              {addVideosMutation.isPending
                ? "Adding..."
                : selectedVideos.length === 0
                ? "Add videos"
                : `Add ${selectedVideos.length} video${
                    selectedVideos.length === 1 ? "" : "s"
                  }`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

interface VideoCardProps {
  video: UserVideo;
  isSelected: boolean;
  onToggle: () => void;
  isAlreadyInSpace: boolean;
}

const VideoCard: React.FC<VideoCardProps> = ({
  video,
  isSelected,
  onToggle,
  isAlreadyInSpace,
}) => {
  const effectiveDate = video.metadata?.customCreatedAt
    ? new Date(video.metadata.customCreatedAt)
    : video.createdAt;

  return (
    <div
      onClick={isAlreadyInSpace ? undefined : onToggle}
      className={clsx(
        "flex items-center gap-4 p-3 group transition-all duration-200 rounded-lg mx-1",
        isAlreadyInSpace
          ? "cursor-not-allowed bg-gray-50 border-gray-300 border-2"
          : isSelected
          ? "cursor-pointer ring-2 ring-blue-500 ring-offset-2 border-blue-500 bg-blue-50"
          : "cursor-pointer bg-white border-gray-200 hover:border-gray-300"
      )}
    >
      <div className="relative flex-shrink-0">
        {!isAlreadyInSpace && (
          <div
            className={`absolute -top-2 -left-2 z-20 transition-opacity duration-200 ${
              isSelected ? "opacity-100" : "group-hover:opacity-100 opacity-0"
            }`}
          >
            <div
              className={clsx(
                "flex justify-center items-center w-5 h-5 rounded border-2 transition-all duration-200",
                isSelected
                  ? "bg-blue-500 border-blue-500"
                  : "bg-gray-100 shadow-sm"
              )}
            >
              {isSelected && (
                <FontAwesomeIcon
                  icon={faCheck}
                  className="text-white text-xs"
                />
              )}
            </div>
          </div>
        )}

        <div className="w-32 h-20 bg-gray-100 rounded-lg overflow-hidden relative">
          <VideoThumbnail
            imageClass="w-full h-full object-cover transition-all duration-200 group-hover:scale-105"
            userId={video.ownerId}
            videoId={video.id}
            alt={`${video.name} Thumbnail`}
          />
        </div>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <h3
            className={clsx(
              "text-sm font-medium truncate leading-tight",
              isAlreadyInSpace ? "text-gray-600" : "text-gray-900"
            )}
          >
            {video.name}
          </h3>
          {isAlreadyInSpace && (
            <span className="bg-gray-200 text-gray-700 text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0">
              ✓ Added
            </span>
          )}
        </div>
        <div
          className={clsx(
            "flex items-center space-x-2",
            isAlreadyInSpace ? "text-gray-500" : "text-gray-500"
          )}
        >
          <p className="text-xs text-gray-500">
            {moment(effectiveDate).format("MMM D, YYYY")}
          </p>
        </div>
      </div>
    </div>
  );
};
