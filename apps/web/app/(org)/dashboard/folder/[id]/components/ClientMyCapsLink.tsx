"use client";

import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { moveVideoToFolder } from '../actions';
import clsx from 'clsx';

export function ClientMyCapsLink() {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isMovingVideo, setIsMovingVideo] = useState(false);

  const handleDragOver = (e: React.DragEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation();

    // Check if the dragged item is a CapCard
    if (e.dataTransfer.types.includes("application/cap")) {
      setIsDragOver(true);
      e.dataTransfer.dropEffect = "move";
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    try {
      const data = e.dataTransfer.getData("application/cap");
      if (!data) return;

      const capData = JSON.parse(data);
      if (!capData.id) return;

      setIsMovingVideo(true);
      // Pass null as folderId to remove the parentId from the video
      await moveVideoToFolder({ videoId: capData.id, folderId: null });
      toast.success(`"${capData.name}" moved to My Caps`);
    } catch (error) {
      console.error("Error moving video to My Caps:", error);
      toast.error("Failed to move video to My Caps");
    } finally {
      setIsMovingVideo(false);
    }
  };

  return (
    <Link 
      href="/dashboard/caps" 
      className={clsx(
        "text-xl whitespace-nowrap transition-colors duration-200 text-gray-9 hover:text-gray-12",
        isDragOver && "text-blue-10",
        isMovingVideo && "opacity-70"
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      My Caps
    </Link>
  );
}
