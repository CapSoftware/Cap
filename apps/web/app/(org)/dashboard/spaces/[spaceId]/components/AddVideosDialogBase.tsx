"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import React, { useState, useEffect, useMemo, useCallback } from "react";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import clsx from "clsx";
import VirtualizedVideoGrid from "./VirtualizedVideoGrid";

interface AddVideosDialogBaseProps {
  open: boolean;
  onClose: () => void;
  entityId: string;
  entityName: string;
  onVideosAdded?: () => void;
  addVideos: (entityId: string, videoIds: string[]) => Promise<any>;
  removeVideos: (entityId: string, videoIds: string[]) => Promise<any>;
  getVideos: (limit?: number) => Promise<any>;
  getEntityVideoIds: (entityId: string) => Promise<any>;
}

export interface Video {
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
  removeVideos,
  getVideos,
  getEntityVideoIds,
}) => {
  const [selectedVideos, setSelectedVideos] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const filterTabs = ['all', 'added', 'notAdded'];

  const queryClient = useQueryClient();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      search: "",
    },
  });

  const { data: videosData, isLoading } = useQuery<Video[]>({
    queryKey: ["user-videos"],
    queryFn: async () => {
      const result = await getVideos();
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    },
    enabled: open,
    refetchOnWindowFocus: false, // Don't refetch when window regains focus
    staleTime: Infinity, // Consider data fresh forever (until manually invalidated)
    gcTime: 1000 * 60 * 5, // Cache for 5 minutes (gcTime is the new name for cacheTime)
  });

  const { data: entityVideoIds } = useQuery<string[]>({
    queryKey: ["entity-video-ids", entityId],
    queryFn: async () => {
      const result = await getEntityVideoIds(entityId);
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    },
    enabled: open,
    refetchOnWindowFocus: false, // Don't refetch when window regains focus
    staleTime: Infinity, // Consider data fresh forever (until manually invalidated)
    gcTime: 1000 * 60 * 5, // Cache for 5 minutes (gcTime is the new name for cacheTime)
  });

  const updateVideosMutation = useMutation({
    mutationFn: async ({ toAdd, toRemove }: { toAdd: string[]; toRemove: string[] }) => {
      let addResult = { success: true, message: "", error: "" };
      let removeResult = { success: true, message: "", error: "" };
      if (toAdd.length > 0) {
        addResult = await addVideos(entityId, toAdd);
      }
      if (toRemove.length > 0) {
        removeResult = await removeVideos(entityId, toRemove);
      }
      return { addResult, removeResult };
    },
    onSuccess: async (result) => {
      const { addResult, removeResult } = result || {};

      // Invalidate both queries to ensure UI updates
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["user-videos"] }),
        queryClient.invalidateQueries({ queryKey: ["entity-video-ids", entityId] })
      ]);

      if ((addResult?.success ?? true) && (removeResult?.success ?? true)) {
        toast.success("Videos updated successfully");
        setSelectedVideos([]);
        onVideosAdded?.();
        onClose();
      } else {
        toast.error(addResult.error || removeResult.error || "Failed to update videos");
      }
    },
    onError: (error) => {
      toast.error("Failed to update videos");
      console.error("Error updating videos:", error);
    },
  });

  // Tab state: 'all', 'added', or 'notAdded'
  const [videoTab, setVideoTab] = useState<typeof filterTabs[number]>('all');

  // Memoize filtered videos for stable reference
  const filteredVideos: Video[] = useMemo(() => {
    let vids = videosData?.filter((video: Video) =>
      video.name.toLowerCase().includes(searchTerm.toLowerCase())
    ) || [];
    if (videoTab === 'added') {
      vids = vids.filter((video: Video) => entityVideoIds?.includes(video.id));
    } else if (videoTab === 'notAdded') {
      vids = vids.filter((video: Video) => !entityVideoIds?.includes(video.id));
    }
    return vids;
  }, [videosData, searchTerm, videoTab, entityVideoIds]);


  // Memoize handleVideoToggle for stable reference
  const handleVideoToggle = useCallback((videoId: string) => {
    setSelectedVideos((prev) =>
      prev.includes(videoId)
        ? prev.filter((id) => id !== videoId)
        : [...prev, videoId]
    );
  }, []);

  const handleUpdateVideos = () => {
    if (!entityVideoIds) return;
    // To add: selected and not already in entity
    const toAdd = selectedVideos.filter(id => !entityVideoIds.includes(id));
    // To remove: selected and already in entity
    const toRemove = selectedVideos.filter(id => entityVideoIds.includes(id));
    updateVideosMutation.mutate({ toAdd, toRemove });
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
      <DialogContent className="flex flex-col p-0 w-[calc(100%-20px)] max-w-2xl rounded-xl border bg-gray-2 border-gray-4">
        <DialogHeader
          icon={<FontAwesomeIcon icon={faVideo} />}
          description={
            "Find and add videos you have previously recorded to share with people in this " +
            entityName +
            "."
          }
        >
          <DialogTitle className="text-lg text-gray-12">
            Add Videos
          </DialogTitle>
        </DialogHeader>
        {/* Tabs for filtering */}
        <div className="flex w-full h-12 border-b bg-gray-1 border-gray-4">
          {filterTabs.map((tab) => (
            <div
              key={tab}
              className={clsx(
                "flex relative flex-1 justify-center items-center w-full min-w-0 text-sm font-medium transition-colors",
                videoTab === tab
                  ? "cursor-not-allowed bg-gray-3"
                  : "cursor-pointer"
              )}
              onClick={() => setVideoTab(tab as 'all' | 'added' | 'notAdded')}
            >
              <p
                className={clsx(
                  videoTab === tab
                    ? "text-gray-12 font-medium"
                    : "text-gray-10",
                  "text-sm"
                )}
              >
                {tab === "all" ? "All" : tab === "added" ? "Added" : "Not Added"}
              </p>
            </div>
          ))}
        </div>

        <div className="flex overflow-hidden flex-col flex-1 px-4 py-4 min-h-0 sm:px-8 sm:py-6">
          <div className="flex-shrink-0 mb-3">
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

          <div className="flex-1 w-full">
            {isLoading ? (
              <div className="flex justify-center items-center h-64">
                <div className="w-8 h-8 rounded-full border-b-2 border-blue-500 animate-spin"></div>
              </div>
            ) : filteredVideos.length === 0 ? (
              <div className="flex flex-col justify-center items-center h-24 text-center">
                <h3 className="text-lg font-medium text-gray-12">
                  {searchTerm
                    ? videoTab === 'added'
                      ? 'No added videos found'
                      : videoTab === 'notAdded'
                        ? 'No not added videos found'
                        : 'No videos found'
                    : videoTab === 'added'
                      ? 'No added videos'
                      : videoTab === 'notAdded'
                        ? 'No videos to add'
                        : 'No videos'}
                </h3>
                <p className="max-w-sm text-sm text-gray-11">
                  {searchTerm
                    ? 'Try adjusting your search terms.'
                    : videoTab === 'added'
                      ? `You haven't added any videos to this ${entityName} yet.`
                      : videoTab === 'notAdded'
                        ? `Record or upload videos to add them to this ${entityName}.`
                        : `Record or upload videos to see them here.`}
                </p>
              </div>
            ) : (
              <VirtualizedVideoGrid
                videos={filteredVideos}
                selectedVideos={selectedVideos}
                handleVideoToggle={handleVideoToggle}
                entityVideoIds={entityVideoIds || []}
                height={300}
                columnCount={3}
                rowHeight={200}
              />
            )}
          </div>
        </div>

        <div className="flex flex-shrink-0 justify-between items-center px-4 py-4 rounded-b-xl border-t sm:px-8 sm:py-6 border-gray-4 bg-gray-3">
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
              disabled={updateVideosMutation.isPending}
              spinner={updateVideosMutation.isPending}
              onClick={handleUpdateVideos}
              className="px-3 py-2 text-sm sm:px-4"
            >
              {updateVideosMutation.isPending
                ? "Updating..."
                : "Update videos"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};


export default AddVideosDialogBase;
