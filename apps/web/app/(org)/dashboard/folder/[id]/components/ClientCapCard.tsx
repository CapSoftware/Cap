"use client";

import { CapCard, CapCardProps } from "../../../caps/components/CapCard/CapCard";
import { deleteVideo } from "@/actions/videos/delete";
import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

type ClientCapCardProps = Omit<CapCardProps, 'onDelete'> & {
  videoId: string;
};

// Interface for drop targets that will be registered for mobile drag and drop
interface DropTarget {
  element: HTMLElement;
  onDrop: (data: any) => void;
  onDragOver?: () => void;
  onDragLeave?: () => void;
}

// Global registry for drop targets
let dropTargets: DropTarget[] = [];

// Register a drop target element
export function registerDropTarget(
  element: HTMLElement,
  onDrop: (data: any) => void,
  onDragOver?: () => void,
  onDragLeave?: () => void
) {
  dropTargets.push({ element, onDrop, onDragOver, onDragLeave });
  return () => {
    dropTargets = dropTargets.filter(target => target.element !== element);
  };
}

export function ClientCapCard(props: ClientCapCardProps) {
  const { videoId, ...rest } = props;
  const router = useRouter();
  const [isDragging, setIsDragging] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [touchDragging, setTouchDragging] = useState(false);
  const [touchPosition, setTouchPosition] = useState({ x: 0, y: 0 });
  const dragDataRef = useRef<any>(null);

  const handleDelete = async (videoId: string) => {
    try {
      await deleteVideo(videoId);
      router.refresh();
      toast.success('Video deleted successfully');
    } catch (error) {
      console.error('Error deleting video:', error);
      toast.error('Failed to delete video');
    }
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

  // Create the data object for drag operations
  const createDragData = () => {
    return {
      id: videoId,
      name: props.cap.name,
      type: "application/cap"
    };
  };

  // Handle drag start event for desktop
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

      // Adjust offset based on whether we have a thumbnail
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

  // Touch event handlers for mobile drag and drop
  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    // Store the drag data for potential drop
    dragDataRef.current = createDragData();

    // Get touch position
    if (e.touches.length > 0) {
      const touch = e.touches[0];
      // Safely access touch properties
      if (touch) {
        const initialX = touch.clientX;
        const initialY = touch.clientY;

        // Set a timeout to distinguish between tap and drag
        const timer = setTimeout(() => {
          // Start dragging after a short delay to avoid accidental drags
          setTouchDragging(true);
          setTouchPosition({ x: initialX, y: initialY });
        }, 200);

        // Clear the timer if the touch ends quickly (tap)
        const clearTimer = () => clearTimeout(timer);
        document.addEventListener('touchend', clearTimer, { once: true });
      }
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!touchDragging) return;

    // Prevent scrolling while dragging
    e.preventDefault();

    if (e.touches.length > 0) {
      const touch = e.touches[0];
      // Safely access touch properties
      if (touch) {
        setTouchPosition({ x: touch.clientX, y: touch.clientY });

        // Check if we're over any drop targets
        checkDropTargets(touch.clientX, touch.clientY);
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!touchDragging) return;

    // Check if we're over a drop target and trigger the drop
    if (e.changedTouches.length > 0) {
      const lastTouch = e.changedTouches[0];
      // Safely access touch properties
      if (lastTouch) {
        const dropTarget = findDropTargetAtPosition(lastTouch.clientX, lastTouch.clientY);

        if (dropTarget && dragDataRef.current) {
          dropTarget.onDrop(dragDataRef.current);
        }
      }
    }

    // Reset dragging state
    setTouchDragging(false);
    dragDataRef.current = null;
  };

  // Helper function to check if we're over a drop target
  const checkDropTargets = (x: number, y: number) => {
    // Highlight the drop target we're over (if any)
    dropTargets.forEach(target => {
      const rect = target.element.getBoundingClientRect();
      const isOver = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

      // Add/remove a class to highlight the drop target
      if (isOver) {
        target.element.classList.add('drag-over');
        // Trigger the onDragOver callback if provided
        if (target.onDragOver) {
          target.onDragOver();
        }
      } else if (target.element.classList.contains('drag-over')) {
        target.element.classList.remove('drag-over');
        // Trigger the onDragLeave callback if provided
        if (target.onDragLeave) {
          target.onDragLeave();
        }
      }
    });
  };

  // Helper function to find a drop target at a position
  const findDropTargetAtPosition = (x: number, y: number) => {
    return dropTargets.find(target => {
      const rect = target.element.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
  };

  return (
    <>
      <div
        ref={cardRef}
        draggable={true}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className={isDragging || touchDragging ? "opacity-50" : ""}
      >
        <CapCard {...rest} onDelete={() => handleDelete(videoId)} />
      </div>

      {/* Mobile drag preview */}
      {touchDragging && typeof document !== 'undefined' && createPortal(
        <div
          className="flex fixed z-50 gap-2 items-center px-3 py-2 rounded-lg border shadow-md pointer-events-none bg-gray-1 border-gray-4"
          style={{
            left: `${touchPosition.x - 20}px`,
            top: `${touchPosition.y - 30}px`,
          }}
        >
          <span className="text-sm font-medium text-gray-12">{props.cap.name}</span>
        </div>,
        document.body
      )}
    </>
  );
}
