import type { Video } from "@inflight/web-domain";
import { Grid, useGrid } from "@virtual-grid/react";
import { type RefObject, useEffect, useRef, useState } from "react";
import type { VideoData } from "./AddVideosDialogBase";
import VideoCard from "./VideoCard";

interface VirtualizedVideoGridProps {
	videos: VideoData[];
	selectedVideos: string[];
	handleVideoToggle: (id: Video.VideoId) => void;
	entityVideoIds: Video.VideoId[];
	height?: number;
	columnCount?: number;
	rowHeight?: number;
}

const VirtualizedVideoGrid = ({
	videos,
	selectedVideos,
	handleVideoToggle,
	entityVideoIds,
	height = 400,
	columnCount = 3,
	rowHeight = 200,
}: VirtualizedVideoGridProps) => {
	// Create a ref for the scrollable container
	const scrollRef = useRef<HTMLDivElement>(null);

	// State for responsive column count and width
	const [responsiveColumnCount, setResponsiveColumnCount] =
		useState(columnCount);

	// Handle responsive column count
	useEffect(() => {
		// Function to update column count and width based on screen size
		const updateResponsiveLayout = () => {
			const isMobile = window.matchMedia("(max-width: 640px)").matches;
			setResponsiveColumnCount(isMobile ? 1 : columnCount);
		};

		// Set initial value
		updateResponsiveLayout();

		// Add event listener for window resize
		window.addEventListener("resize", updateResponsiveLayout);

		// Clean up
		return () => window.removeEventListener("resize", updateResponsiveLayout);
	}, [columnCount]);

	// Initialize the grid with responsive column count
	const grid = useGrid({
		scrollRef: scrollRef as RefObject<HTMLDivElement>, // React typing version mismatch
		count: videos.length,
		columns: responsiveColumnCount,
		gap: {
			y: 16,
			x: 12,
		},
		size: {
			height: rowHeight,
		},
		overscan: 5, // Add overscan to prevent refetching when scrolling
	});

	return (
		<div
			ref={scrollRef}
			style={{
				height,
				overflowX: "hidden",
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
						<div
							key={video.id}
							className="px-2 mx-auto md:mx-0 md:px-0 w-[96%] h-full"
						>
							<VideoCard
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
};

export default VirtualizedVideoGrid;
