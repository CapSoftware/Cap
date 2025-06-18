import React, { useRef, useMemo } from "react";
import { Grid, useGrid } from '@virtual-grid/react';
import VideoCard from "./VideoCard";
import { Video } from "./AddVideosDialogBase";

interface VirtualizedVideoGridProps {
  videos: Video[];
  selectedVideos: string[];
  handleVideoToggle: (id: string) => void;
  entityVideoIds: string[];
  height?: number;
  columnCount?: number;
  rowHeight?: number;
  columnWidth?: number;
}

const VirtualizedVideoGrid = ({
  videos,
  selectedVideos,
  handleVideoToggle,
  entityVideoIds,
  height = 400,
  columnCount = 3,
  rowHeight = 200,
  columnWidth = 200,
}: VirtualizedVideoGridProps) => {
  // Create a ref for the scrollable container
  const scrollRef = useRef<HTMLDivElement>(null);

  // Initialize the grid
  const grid = useGrid({
    scrollRef,
    count: videos.length,
    columns: columnCount,
    // The itemSize and padding are passed directly as style props
  });

  return (
    <div
      ref={scrollRef}
      style={{
        height,
        overflow: 'auto',
        overflowX: 'hidden',
      }}
      className="pt-2 custom-scroll"
    >
      <Grid grid={grid}>
        {(index) => {
          // Skip rendering if index is out of bounds
          if (index >= videos.length) return null;

          // Get the video at this index (we know it exists because of the check above)
          const video = videos[index]!;

          return (
            <div style={{
              padding: '8px 12px 0 0',
              width: columnWidth,
              height: rowHeight,
            }}>
              <VideoCard
                key={video.id}
                video={video}
                isSelected={selectedVideos.includes(video.id)}
                onToggle={() => handleVideoToggle(video.id)}
                isAlreadyInEntity={entityVideoIds?.includes(video.id) || false}
              />
            </div>
          );
        }}
      </Grid>
    </div>
  );
}

export default VirtualizedVideoGrid;
