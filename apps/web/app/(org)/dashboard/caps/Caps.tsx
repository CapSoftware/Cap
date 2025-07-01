"use client";
import { deleteVideo } from "@/actions/videos/delete";
import { useApiClient } from "@/utils/web-api";
import { VideoMetadata } from "@cap/database/types";
import { Button } from "@cap/ui";
import { faFolderPlus, faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { NewFolderDialog } from "./components/NewFolderDialog";
import Link from "next/link";
import { useDashboardContext } from "../Contexts";
import { CapCard } from "./components/CapCard/CapCard";
import { CapPagination } from "./components/CapPagination";
import { useTheme } from "../Contexts";
import { EmptyCapState } from "./components/EmptyCapState";
import { SelectedCapsBar } from "./components/SelectedCapsBar";
import { UploadCapButton } from "./components/UploadCapButton";
import { UploadPlaceholderCard } from "./components/UploadPlaceholderCard";
import { deleteFolder, updateFolder } from "../folder/[id]/actions";
import { ConfirmationDialog } from "../_components/ConfirmationDialog";
import { FoldersDropdown } from "./components/FoldersDropdown";

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

type FolderDataType = {
  name: string;
  id: string;
  color: "normal" | "blue" | "red" | "yellow";
  videoCount: number;
};

export const Caps = ({
  data,
  count,
  dubApiKeyEnabled,
  folders,
}: {
  data: VideoData;
  count: number;
  folders: FolderDataType[];
  dubApiKeyEnabled: boolean;
}) => {
  const { refresh } = useRouter();
  const params = useSearchParams();
  const page = Number(params.get("page")) || 1;
  const [analytics, setAnalytics] = useState<Record<string, number>>({});
  const { user } = useDashboardContext();
  const limit = 15;
  const [openNewFolderDialog, setOpenNewFolderDialog] = useState(false);
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
    try {
      const response = await deleteVideo(videoId);
      if (response.success) {
        refresh();
        toast.success("Cap deleted successfully");
      } else {
        throw new Error(
          response.message || "Failed to delete Cap - please try again later"
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        toast.error(error.message);
      } else {
        toast.error("Failed to delete Cap - please try again later");
      }
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
      <div className="flex gap-3 justify-start mb-10">
        <UploadCapButton
          onStart={handleUploadStart}
          size="sm"
          onProgress={handleUploadProgress}
          onComplete={handleUploadComplete}
        />
        <Button
          onClick={() => setOpenNewFolderDialog(true)}
          size="sm"
          variant="dark"
          className="flex gap-2 items-center"
        >
          <FontAwesomeIcon className="size-3.5" icon={faFolderPlus} />
          New Folder
        </Button>
      </div>
      <NewFolderDialog
        open={openNewFolderDialog}
        onOpenChange={setOpenNewFolderDialog}
      />
      {folders.length > 0 && (
        <>
          <h1 className="mb-3 text-xl font-medium text-gray-12">Folders</h1>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4 mb-10">
            {folders.map((folder) => (
              <Folder key={folder.id} {...folder} />
            ))}
          </div>
        </>
      )}
      <h1 className="mb-3 text-xl font-medium text-gray-12">Videos</h1>
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
        <div className="mt-7">
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

const Folder = ({ name, color, id, videoCount }: FolderDataType) => {
  const { theme } = useTheme();
  const [confirmDeleteFolderOpen, setConfirmDeleteFolderOpen] = useState(false);
  const [deleteFolderLoading, setDeleteFolderLoading] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [updateName, setUpdateName] = useState(name);
  const nameRef = useRef<HTMLTextAreaElement>(null);

  const artboard =
    theme === "dark" && color === "normal"
      ? "folder"
      : color === "normal"
        ? "folder-dark"
        : `folder-${color}`;

  const { rive, RiveComponent: FolderRive } = useRive({
    src: "/rive/dashboard.riv",
    artboard,
    animations: "idle",
    autoplay: false,
    layout: new Layout({
      fit: Fit.Contain,
    }),
  });

  const deleteFolderHandler = async () => {
    try {
      setDeleteFolderLoading(true);
      await deleteFolder(id);
      toast.success("Folder deleted successfully");
    } catch (error) {
      toast.error("Failed to delete folder");
    } finally {
      setDeleteFolderLoading(false);
      setConfirmDeleteFolderOpen(false);
    }
  };

  useEffect(() => {
    if (isRenaming && nameRef.current) {
      nameRef.current.focus();
      nameRef.current.select();
    }
  }, [isRenaming]);

  const updateFolderNameHandler = async () => {
    try {
      await updateFolder({ folderId: id, name: updateName });
      toast.success("Folder name updated successfully");
    } catch (error) {
      toast.error("Failed to update folder name");
    } finally {
      setIsRenaming(false);
    }
  };

  return (
    <Link legacyBehavior prefetch={false} href={`/dashboard/folder/${id}`}>
      <div
        onMouseEnter={() => {
          if (!rive) return;
          rive.stop();
          rive.play("folder-open");
        }}
        onMouseLeave={() => {
          if (!rive) return;
          rive.stop();
          rive.play("folder-close");
        }}
        className="flex justify-between items-center px-4 py-4 w-full h-auto rounded-lg border transition-colors duration-200 cursor-pointer bg-gray-3 border-gray-5 hover:bg-gray-4 hover:border-gray-6"
      >
        <div
          className="flex flex-1 gap-3 items-center">
          <FolderRive
            key={theme + "folder" + id}
            className="w-[50px] h-[50px]"
          />
          <div onClick={(e) => {
            e.stopPropagation();
          }} className="flex flex-col justify-center h-10">
            {isRenaming ? (
              <textarea
                ref={nameRef}
                rows={1}
                value={updateName}
                onChange={(e) => setUpdateName(e.target.value)}
                onBlur={async () => {
                  setIsRenaming(false);
                  if (updateName.trim() !== name) {
                    await updateFolderNameHandler();
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setIsRenaming(false);
                    if (updateName.trim() !== name) {
                      updateFolderNameHandler();
                    }
                  }
                }}
                className="w-full resize-none bg-transparent border-none focus:outline-none
                 focus:ring-0 focus:border-none text-gray-12 text-[15px] max-w-[116px] truncate p-0 m-0 h-[22px] leading-[22px] overflow-hidden font-normal tracking-normal"
              />
            ) : (
              <p onClick={(e) => {
                e.stopPropagation()
                setIsRenaming(true)
              }} className="text-[15px] truncate text-gray-12 w-full max-w-[116px] m-0 p-0 h-[22px] leading-[22px] font-normal tracking-normal">{updateName}</p>
            )}
            <p className="text-sm truncate text-gray-10 w-fit">{`${videoCount} ${videoCount === 1 ? "video" : "videos"
              }`}</p>
          </div>
        </div>
        <ConfirmationDialog
          loading={deleteFolderLoading}
          open={confirmDeleteFolderOpen}
          icon={<FontAwesomeIcon icon={faTrash} />}
          onConfirm={deleteFolderHandler}
          onCancel={() => setConfirmDeleteFolderOpen(false)}
          title="Delete Folder"
          description={`Are you sure you want to delete the folder "${name}"? This action cannot be undone.`}
        />
        <FoldersDropdown
          id={id}
          setIsRenaming={setIsRenaming}
          setConfirmDeleteFolderOpen={setConfirmDeleteFolderOpen}
          nameRef={nameRef}
        />
      </div>
    </Link >
  );
};
