"use client";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { useTheme } from "../../Contexts";
import { deleteFolder, updateFolder, moveVideoToFolder } from "../../folder/[id]/actions";
import { ConfirmationDialog } from "../../_components/ConfirmationDialog";
import { FoldersDropdown } from "./FoldersDropdown";
import clsx from "clsx";

export type FolderDataType = {
  name: string;
  id: string;
  color: "normal" | "blue" | "red" | "yellow";
  videoCount: number;
  parentId?: string | null;
};

const Folder = ({ name, color, id, parentId, videoCount }: FolderDataType) => {
  const { theme } = useTheme();
  const [confirmDeleteFolderOpen, setConfirmDeleteFolderOpen] = useState(false);
  const [deleteFolderLoading, setDeleteFolderLoading] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [updateName, setUpdateName] = useState(name);
  const nameRef = useRef<HTMLTextAreaElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isMovingVideo, setIsMovingVideo] = useState(false);

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

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    // Check if the dragged item is a CapCard
    if (e.dataTransfer.types.includes("application/cap")) {
      setIsDragOver(true);
      e.dataTransfer.dropEffect = "move";
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    try {
      const data = e.dataTransfer.getData("application/cap");
      if (!data) return;

      const capData = JSON.parse(data);
      if (!capData.id) return;

      setIsMovingVideo(true);
      await moveVideoToFolder({ videoId: capData.id, folderId: id });
      toast.success(`"${capData.name}" moved to "${name}" folder`);
    } catch (error) {
      console.error("Error moving video to folder:", error);
      toast.error("Failed to move video to folder");
    } finally {
      setIsMovingVideo(false);
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
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={clsx(
          "flex justify-between items-center px-4 py-4 w-full h-auto rounded-lg border transition-colors duration-200 cursor-pointer bg-gray-3 hover:bg-gray-4 hover:border-gray-6",
          isDragOver ? "border-blue-10 bg-gray-4" : "border-gray-5",
          isMovingVideo && "opacity-70"
        )}
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
          parentId={parentId}
          setIsRenaming={setIsRenaming}
          setConfirmDeleteFolderOpen={setConfirmDeleteFolderOpen}
          nameRef={nameRef}
        />
      </div>
    </Link >
  );
};

export default Folder;
