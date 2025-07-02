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

  // Create a drag preview element with thumbnail
  const createDragPreview = (text: string): HTMLElement => {
    // Create the container element
    const container = document.createElement('div');
    container.className = 'flex gap-2 items-center px-3 py-2 rounded-lg border shadow-md bg-gray-1 border-gray-4';
    container.style.position = 'absolute';
    container.style.top = '-9999px';
    container.style.left = '-9999px';

    // Add the text
    const textElement = document.createElement('span');
    textElement.textContent = text;
    textElement.className = 'text-sm font-medium text-gray-12';
    container.appendChild(textElement);

    return container;
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
