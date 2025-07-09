"use client";

import Link from "next/link";
import { useState, useEffect, useRef } from "react";
import { moveVideoToFolder } from "@/actions/folders/moveVideoToFolder";
import { toast } from "sonner";
import clsx from "clsx";
import { registerDropTarget } from "./ClientCapCard";
import { useRouter } from "next/navigation";
import { useDashboardContext } from "../../../Contexts";
import { Avatar } from "@cap/ui";
import Image from "next/image";

export function ClientMyCapsLink() {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isMovingVideo, setIsMovingVideo] = useState(false);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const router = useRouter();
  const { activeSpace } = useDashboardContext();

  // Register this component as a drop target for mobile drag and drop
  useEffect(() => {
    if (!linkRef.current) return;

    const unregister = registerDropTarget(linkRef.current, (data) => {
      if (data && data.type === "application/cap") {
        handleDrop({ id: data.id, name: data.name });
      }
    });

    return () => {
      unregister();
    };
  }, []);

  // Handle drag events for desktop
  const handleDragOver = (e: React.DragEvent<HTMLAnchorElement>) => {
    e.preventDefault();

    // Check if the dragged item is a cap
    if (e.dataTransfer.types.includes("application/cap")) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent<HTMLAnchorElement> | { id: string, name: string }) => {
    if ('preventDefault' in e) {
      e.preventDefault();

      try {
        // Get the cap data from the data transfer
        const capData = JSON.parse(e.dataTransfer.getData("application/cap"));

        if (!capData || !capData.id) {
          console.error("Invalid cap data");
          return;
        }

        await processDrop(capData);
      } catch (error) {
        console.error("Error processing drop:", error);
        toast.error("Failed to move video");
      }
    } else {
      // Handle mobile drop with direct data
      await processDrop(e);
    }
  };

  // Common function to process the drop for both desktop and mobile
  const processDrop = async (capData: { id: string, name: string }) => {
    setIsDragOver(false);

    try {
      if (!capData || !capData.id) {
        console.error("Invalid cap data");
        return;
      }

      setIsMovingVideo(true);

      // Move the video to the root folder (null parentId)
      await moveVideoToFolder({
        videoId: capData.id,
        folderId: null,
        spaceId: activeSpace?.id,
      });
      router.refresh();
      if (activeSpace) {
        toast.success(`Moved "${capData.name}" to "${activeSpace.name}"`);
      } else {
        toast.success(`Moved "${capData.name}" to My Caps`);
      }
    } catch (error) {
      console.error("Error moving video:", error);
      toast.error("Failed to move video");
    } finally {
      setIsMovingVideo(false);
    }
  };

  return (
    <Link
      ref={linkRef}
      href={activeSpace ? `/dashboard/spaces/${activeSpace.id}` : "/dashboard/caps"}
      className={clsx(
        "text-xl whitespace-nowrap flex items-center gap-1.5 transition-colors duration-200 hover:text-gray-12",
        isDragOver ? "text-blue-10" : "text-gray-9",
        isMovingVideo && "opacity-70",
        "drag-target" // Add a class for styling when used as a drop target
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {activeSpace && activeSpace.iconUrl ? (
        <Image
          src={activeSpace.iconUrl}
          alt={activeSpace.name || "Space"}
          width={20}
          height={20}
          className="rounded-full"
        />
      ) : activeSpace && !activeSpace.iconUrl && (
        <Avatar
          letterClass="text-xs"
          className="relative flex-shrink-0 size-5"
          name={activeSpace?.name}
        />
      )}
      {activeSpace ? activeSpace.name : "My Caps"}
    </Link>
  );
}
