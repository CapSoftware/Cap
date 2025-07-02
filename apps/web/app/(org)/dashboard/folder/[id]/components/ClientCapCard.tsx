"use client";

import { CapCard, CapCardProps } from "../../../caps/components/CapCard/CapCard";
import { deleteVideo } from "@/actions/videos/delete";
import { useState } from "react";

type ClientCapCardProps = Omit<CapCardProps, 'onDelete'> & {
  videoId: string;
};

export function ClientCapCard(props: ClientCapCardProps) {
  const { videoId, ...rest } = props;
  const [isDragging, setIsDragging] = useState(false);

  const handleDelete = async (videoId: string) => {
    await deleteVideo(videoId);
  };

  // Create a drag preview element
  const createDragPreview = (text: string): HTMLElement => {
    const element = document.createElement('div');
    element.textContent = text;
    element.className = 'px-2 py-1.5 text-sm font-medium rounded-lg shadow-md text-gray-1 bg-gray-12';
    element.style.position = 'absolute';
    element.style.top = '-9999px';
    element.style.left = '-9999px';
    return element;
  };

  // Handle drag start event
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    // Set the data transfer
    e.dataTransfer.setData(
      "application/cap",
      JSON.stringify({
        id: videoId,
        name: props.cap.name,
      })
    );

    // Set drag effect to 'move'
    e.dataTransfer.effectAllowed = 'move';

    // Set the drag image
    try {
      const dragPreview = createDragPreview(props.cap.name);
      document.body.appendChild(dragPreview);
      e.dataTransfer.setDragImage(dragPreview, 10, 10);

      // Clean up after a short delay
      setTimeout(() => document.body.removeChild(dragPreview), 100);
    } catch (error) {
      console.error('Error setting drag image:', error);
    }

    setIsDragging(true);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  return (
    <div
      draggable={true}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      className={isDragging ? "opacity-50" : ""}
    >
      <CapCard {...rest} onDelete={() => handleDelete(videoId)} />
    </div>
  );
}
