"use client";

import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@cap/ui";
import {
  faFolderOpen,
  faChevronRight,
  faChevronDown,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useEffectMutation, useEffectQuery } from "@/lib/EffectRuntime";
import { useState } from "react";
import { getAllFoldersAction } from "../../../../actions/folders/getAllFolders";
import { moveVideosToFolderAction } from "../../../../actions/folders/moveVideosToFolder";
import { useDashboardContext } from "../Contexts";
import { toast } from "sonner";
import { Effect } from "effect";
import { useQueryClient } from "@tanstack/react-query";

type FolderWithChildren = {
  id: string;
  name: string;
  color: "normal" | "blue" | "red" | "yellow";
  parentId: string | null;
  organizationId: string;
  videoCount: number;
  children: FolderWithChildren[];
};

interface FolderSelectionDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (folderId: string | null) => void;
  selectedCount: number;
  videoIds: string[];
}

export function FolderSelectionDialog({
  open,
  onClose,
  onConfirm,
  selectedCount,
  videoIds,
}: FolderSelectionDialogProps) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set()
  );
  const { activeOrganization, activeSpace } = useDashboardContext();
  const queryClient = useQueryClient();

  const { data: foldersData, isLoading } = useEffectQuery({
    queryKey: ["folders", activeOrganization?.organization.id, activeSpace?.id],
    queryFn: () =>
      Effect.tryPromise(() => {
        const root = activeSpace?.id
          ? { variant: "space" as const, spaceId: activeSpace.id }
          : {
              variant: "org" as const,
              organizationId: activeOrganization!.organization.id,
            };

        return getAllFoldersAction(root).then((result) => {
          if (!result.success) {
            throw new Error(result.error || "Failed to fetch folders");
          }
          return result.folders;
        });
      }),
    enabled: open && !!activeOrganization?.organization.id,
  });

  const folders = foldersData || [];

  const moveVideosMutation = useEffectMutation({
    mutationFn: (params: {
      videoIds: string[];
      targetFolderId: string | null;
      spaceId?: string | null;
    }) =>
      Effect.tryPromise(() =>
        moveVideosToFolderAction(params).then((result) => {
          if (!result.success) {
            throw new Error(result.error || "Failed to move videos");
          }
          return result;
        })
      ),
    onSuccess: (result) => {
      toast.success(result.message);

      const foldersQueryKey = [
        "folders",
        activeOrganization?.organization.id,
        activeSpace?.id,
      ];

      queryClient.setQueryData(
        foldersQueryKey,
        (oldFolders: FolderWithChildren[] | undefined) => {
          if (!oldFolders) return oldFolders;

          return oldFolders.map((folder) => ({
            ...folder,
            videoCount: result.originalFolderIds.includes(folder.id)
              ? Math.max(0, folder.videoCount - videoIds.length)
              : folder.id === selectedFolderId
              ? folder.videoCount + videoIds.length
              : folder.videoCount,
            children:
              folder.children?.map((child) => ({
                ...child,
                videoCount: result.originalFolderIds.includes(child.id)
                  ? Math.max(0, child.videoCount - videoIds.length)
                  : child.id === selectedFolderId
                  ? child.videoCount + videoIds.length
                  : child.videoCount,
              })) || [],
          }));
        }
      );

      queryClient.setQueriesData(
        { queryKey: ["videos"] },
        (oldVideos: any[] | undefined) => {
          if (!oldVideos) return oldVideos;

          return oldVideos.map((video) =>
            videoIds.includes(video.id)
              ? { ...video, folderId: selectedFolderId }
              : video
          );
        }
      );

      onConfirm(selectedFolderId);
      setSelectedFolderId(null);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to move videos"
      );
      console.error("Error moving videos:", error);
    },
  });

  const toggleFolderExpansion = (folderId: string) => {
    setExpandedFolders((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(folderId)) {
        newSet.delete(folderId);
      } else {
        newSet.add(folderId);
      }
      return newSet;
    });
  };

  const renderFolder = (folder: FolderWithChildren, depth = 0) => {
    const hasChildren = folder.children && folder.children.length > 0;
    const isExpanded = expandedFolders.has(folder.id);
    const isSelected = selectedFolderId === folder.id;

    return (
      <div key={folder.id} className="relative">
        <div
          onClick={() => setSelectedFolderId(folder.id)}
          className={`
            group flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer
            transition-colors border-l-4
            ${
              isSelected
                ? "bg-blue-3 border-blue-9"
                : "border-transparent hover:bg-gray-3"
            }
          `}
          style={{ marginLeft: `${depth * 16}px` }}
        >
          {hasChildren ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleFolderExpansion(folder.id);
              }}
              className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-gray-4 transition"
            >
              <FontAwesomeIcon
                className="w-3.5 h-3.5 text-gray-10"
                icon={isExpanded ? faChevronDown : faChevronRight}
              />
            </button>
          ) : (
            <div className="w-5 h-5 flex-shrink-0" />
          )}

          <div className="flex items-center gap-2 flex-1">
            <div className="flex-shrink-0 w-7 h-7 rounded-md bg-gray-2 border border-gray-6 shadow-sm flex items-center justify-center">
              <FontAwesomeIcon
                className="w-4 h-4 text-gray-11"
                icon={faFolderOpen}
              />
            </div>

            <div className="flex-1">
              <p className="text-sm font-medium text-gray-12">{folder.name}</p>
              <p className="text-xs text-gray-9">
                {folder.videoCount} video{folder.videoCount !== 1 ? "s" : ""}
              </p>
            </div>
          </div>

          {isSelected && (
            <div className="ml-auto w-5 h-5 rounded-full bg-blue-9 flex items-center justify-center">
              <div className="w-2.5 h-2.5 bg-white rounded-full" />
            </div>
          )}
        </div>

        {hasChildren && isExpanded && (
          <div className="mt-1">
            {folder.children.map((child) => renderFolder(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const handleConfirm = () => {
    moveVideosMutation.mutate({
      videoIds,
      targetFolderId: selectedFolderId,
      spaceId: activeSpace?.id,
    });
  };

  const handleCancel = () => {
    setSelectedFolderId(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(open) => !open && handleCancel()}>
      <DialogContent className="p-0 w-[calc(100%-20px)] max-w-md rounded-xl border bg-gray-2 border-gray-4">
        <DialogHeader icon={<FontAwesomeIcon icon={faFolderOpen} />}>
          <DialogTitle className="text-lg text-gray-12">
            Move {selectedCount} cap{selectedCount !== 1 ? "s" : ""} to folder
          </DialogTitle>
        </DialogHeader>
        <div className="p-5">
          <p className="mb-4 text-[14px] leading-5 text-gray-11">
            Select a destination folder for the selected caps.
          </p>

          <div className="space-y-2 max-h-[320px] overflow-y-auto custom-scroll">
            <div
              onClick={() => setSelectedFolderId(null)}
              className={`
                flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer
                transition-colors border-l-4
                ${
                  selectedFolderId === null
                    ? "bg-blue-3 border-blue-9"
                    : "border-transparent hover:bg-gray-3"
                }
              `}
            >
              <div className="flex-shrink-0 w-7 h-7 rounded-md bg-gray-2 border border-gray-6 shadow-sm flex items-center justify-center">
                <FontAwesomeIcon
                  className="w-4 h-4 text-gray-11"
                  icon={faFolderOpen}
                />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-12">
                  {activeOrganization?.organization.name || "My Caps"}
                </p>
                <p className="text-xs text-gray-9">Move to root folder</p>
              </div>
              {selectedFolderId === null && (
                <div className="ml-auto w-5 h-5 rounded-full bg-blue-9 flex items-center justify-center">
                  <div className="w-2.5 h-2.5 bg-white rounded-full" />
                </div>
              )}
            </div>

            {isLoading && (
              <div className="text-center py-4">
                <p className="text-sm text-gray-10">Loading folders...</p>
              </div>
            )}

            {!isLoading &&
              folders.map((folder: FolderWithChildren) => renderFolder(folder))}
          </div>

          {!isLoading && folders.length === 0 && (
            <div className="text-center py-8">
              <FontAwesomeIcon
                className="w-8 h-8 text-gray-8 mb-3"
                icon={faFolderOpen}
              />
              <p className="text-sm text-gray-10">No folders available</p>
              <p className="text-xs text-gray-9 mt-1">
                Create a folder first to organize your caps
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            onClick={handleCancel}
            variant="gray"
            size="sm"
            disabled={moveVideosMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            variant="dark"
            size="sm"
            spinner={moveVideosMutation.isPending}
            disabled={moveVideosMutation.isPending}
          >
            {moveVideosMutation.isPending ? "Moving..." : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
