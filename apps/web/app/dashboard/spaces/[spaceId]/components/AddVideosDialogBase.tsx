"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
} from "@cap/ui";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faVideo } from "@fortawesome/free-solid-svg-icons";
import { VideoThumbnail } from "@/components/VideoThumbnail";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Check } from "lucide-react";
import moment from "moment";
import clsx from "clsx";
import { motion } from "framer-motion";
import { Tooltip } from "@/components/Tooltip";

interface AddVideosDialogBaseProps {
  open: boolean;
  onClose: () => void;
  entityId: string;
  entityName: string;
  onVideosAdded?: () => void;
  addVideos: (entityId: string, videoIds: string[]) => Promise<any>;
  getVideos: (limit: number) => Promise<any>;
  getEntityVideoIds: (entityId: string) => Promise<any>;
}

interface Video {
  id: string;
  ownerId: string;
  name: string;
  createdAt: Date;
  totalComments: number;
  totalReactions: number;
  ownerName: string;
  metadata?: {
    customCreatedAt?: string;
  };
}

const formSchema = z.object({
  search: z.string(),
});

const AddVideosDialogBase: React.FC<AddVideosDialogBaseProps> = ({
  open,
  onClose,
  entityId,
  entityName,
  onVideosAdded,
  addVideos,
  getVideos,
  getEntityVideoIds,
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
      const result = await getVideos(50);
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    },
    enabled: open,
  });

  const { data: entityVideoIds } = useQuery({
    queryKey: ["entity-video-ids", entityId],
    queryFn: async () => {
      const result = await getEntityVideoIds(entityId);
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    },
    enabled: open,
  });

  const addVideosMutation = useMutation({
    mutationFn: (videoIds: string[]) => addVideos(entityId, videoIds),
    onSuccess: (result) => {
      if (result?.success) {
        toast.success(result.message || "Videos added successfully");
        setSelectedVideos([]);
        onVideosAdded?.();
        onClose();
      } else {
        toast.error(result?.error || "Failed to add videos");
      }
    },
    onError: (error) => {
      toast.error("Failed to add videos");
      console.error("Error adding videos:", error);
    },
  });

  const filteredVideos: Video[] =
    videosData?.filter((video: Video) =>
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
      <DialogContent className="flex flex-col p-0 w-full max-w-2xl rounded-xl border bg-gray-2 border-gray-4">
        <DialogHeader
          icon={<FontAwesomeIcon icon={faVideo} />}
          description={
            "Find and add videos you have previously recorded to share with people in this " +
            entityName +
            "."
          }
        >
          <DialogTitle className="text-lg text-gray-12">
            Add videos to {entityName}
          </DialogTitle>
        </DialogHeader>

        <div className="flex overflow-hidden flex-col flex-1 px-4 py-4 min-h-0 sm:px-8 sm:py-6">
          <div className="flex-shrink-0 px-2 mb-3">
            <div className="flex relative w-full">
              <div className="flex absolute inset-y-0 left-3 items-center pointer-events-none">
                <Search className="size-4 text-gray-9" />
              </div>
              <Input
                placeholder="Search your videos"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="flex-1 pr-3 pl-8 w-full min-w-full text-sm placeholder-gray-8"
              />
            </div>
          </div>

          <div className="overflow-y-auto flex-1 px-1 min-h-0">
            {isLoading ? (
              <div className="flex justify-center items-center h-64">
                <div className="w-8 h-8 rounded-full border-b-2 border-blue-500 animate-spin"></div>
              </div>
            ) : filteredVideos.length === 0 ? (
              <div className="flex flex-col justify-center items-center h-24 text-center">
                <h3 className="text-lg font-medium text-gray-12">
                  {searchTerm ? "No videos found" : "No videos to add"}
                </h3>
                <p className="max-w-sm text-sm text-gray-11">
                  {searchTerm
                    ? "Try adjusting your search terms"
                    : "Record some videos first to add them to this " +
                      entityName}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 max-h-[400px] overflow-y-auto custom-scroll p-1">
                {filteredVideos.map((video) => (
                  <VideoCard
                    key={video.id}
                    video={video}
                    isSelected={selectedVideos.includes(video.id)}
                    onToggle={() => handleVideoToggle(video.id)}
                    isAlreadyInEntity={
                      entityVideoIds?.includes(video.id) || false
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-shrink-0 justify-between items-center px-4 py-4 border-t sm:px-8 sm:py-6 border-gray-4 bg-gray-3">
          <div className="text-xs sm:text-sm text-gray-11">
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
              className="px-3 py-2 text-sm sm:px-4"
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
              className="px-3 py-2 text-sm sm:px-4"
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
  video: Video;
  isSelected: boolean;
  onToggle: () => void;
  isAlreadyInEntity: boolean;
}

const VideoCard: React.FC<VideoCardProps> = ({
  video,
  isSelected,
  onToggle,
  isAlreadyInEntity,
}) => {
  const effectiveDate = video.metadata?.customCreatedAt
    ? new Date(video.metadata.customCreatedAt)
    : video.createdAt;

  return (
    <div
      onClick={isAlreadyInEntity ? undefined : onToggle}
      className={clsx(
        "flex flex-col p-3 h-full rounded-xl border transition-all duration-200 group",
        isAlreadyInEntity
          ? "cursor-not-allowed bg-gray-3 border-gray-6"
          : isSelected
          ? "cursor-pointer bg-gray-3 border-gray-5"
          : "bg-transparent cursor-pointer hover:bg-gray-3 hover:border-gray-5 border-gray-4"
      )}
    >
      {/* Thumbnail First */}
      <div className="relative mb-2 w-full">
        {!isAlreadyInEntity && (
          <motion.div
            key={video.id}
            animate={{
              scale: isSelected ? 1 : 0,
            }}
            initial={{
              scale: isSelected ? 1 : 0,
            }}
            transition={{
              type: isSelected ? "spring" : "tween",
              stiffness: isSelected ? 300 : undefined,
              damping: isSelected ? 20 : undefined,
              duration: !isSelected ? 0.2 : undefined,
            }}
            className="flex absolute -top-2 -right-2 z-10 justify-center items-center bg-green-500 rounded-full bg-gray-4 size-5"
          >
            <Check className="text-white" size={12} />
          </motion.div>
        )}

        <div
          className={clsx(
            "overflow-visible relative w-full h-32 rounded-lg border transition-colors bg-gray-3",
            isSelected || isAlreadyInEntity
              ? "border-green-500"
              : "border-transparent"
          )}
        >
          <VideoThumbnail
            imageClass="w-full h-full transition-all duration-200 group-hover:scale-105"
            userId={video.ownerId}
            videoId={video.id}
            alt={`${video.name} Thumbnail`}
            objectFit="cover"
            containerClass="min-h-full !rounded-lg !border-b-0"
          />
          {isAlreadyInEntity && (
            <span className="absolute right-0 left-0 -bottom-2 z-10 flex-shrink-0 px-2 py-1 mx-auto text-xs font-medium text-white bg-green-600 rounded-full w-fit">
              Added
            </span>
          )}
        </div>
      </div>

      <div className={clsx("space-y-1", isAlreadyInEntity && "mt-3")}>
        {/* Title Second */}
        <Tooltip content={video.name}>
          <h3
            className={clsx(
              "text-sm font-medium leading-tight truncate",
              isAlreadyInEntity ? "text-gray-11" : "text-gray-12"
            )}
          >
            {video.name}
          </h3>
        </Tooltip>

        <p className="text-xs text-gray-9">
          {moment(effectiveDate).format("MMM D, YYYY")}
        </p>
      </div>
    </div>
  );
};

export default AddVideosDialogBase;
