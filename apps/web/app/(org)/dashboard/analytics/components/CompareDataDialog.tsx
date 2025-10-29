import {
	Button,
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@cap/ui";
import { faChartSimple } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { LayoutGroup } from "motion/react";
import { useRef, useState } from "react";
import { CompareDataDroppable, type FilterValue } from "./CompareFilters";
import { FiltersList } from "./FiltersList";
import CompareVideos from "./VideoFilters";
import VideosPicker from "./VideosPicker";

export const CompareDataDialog = ({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) => {
	const [droppedItems, setDroppedItems] = useState<{
		compare: string | null;
		compareTwo: string | null;
	}>({
		compare: null,
		compareTwo: null,
	});
	const [droppedVideos, setDroppedVideos] = useState<{
		video1: string | null;
		video2: string | null;
	}>({
		video1: null,
		video2: null,
	});
	const [isDragging, setIsDragging] = useState(false);
	const [isVideoDragging, setIsVideoDragging] = useState(false);
	const [currentDragValue, setCurrentDragValue] = useState<FilterValue | null>(
		null,
	);
	const [currentDragVideo, setCurrentDragVideo] = useState<string | null>(null);

	const FILTERS: readonly FilterValue[] = [
		"views",
		"comments",
		"reactions",
		"shares",
		"downloads",
		"uploads",
		"deletions",
		"creations",
		"edits",
	] as const;

	const VIDEOS: readonly string[] = [
		"Video A",
		"Video B",
		"Video C",
		"Video D",
	] as const;

	const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 });
	const [videoDragPosition, setVideoDragPosition] = useState({ x: 0, y: 0 });

	const compareRef = useRef<HTMLDivElement>(null);
	const compareTwoRef = useRef<HTMLDivElement>(null);
	const video1Ref = useRef<HTMLDivElement>(null);
	const video2Ref = useRef<HTMLDivElement>(null);

	const handleDrop = (dropZoneId: "compare" | "compareTwo") => {
		if (currentDragValue) {
			setDroppedItems((prev) => ({
				...prev,
				[dropZoneId]: currentDragValue,
			}));
		}
	};

	const handleRemoveItem = (dropZoneId: "compare" | "compareTwo") => {
		setDroppedItems((prev) => ({
			...prev,
			[dropZoneId]: null,
		}));
	};

	const isFilterInUse = (value: string) => {
		return droppedItems.compare === value || droppedItems.compareTwo === value;
	};

	const checkDropZone = (x: number, y: number): string | null => {
		const zones = [
			{ id: "compare", ref: compareRef },
			{ id: "compareTwo", ref: compareTwoRef },
		];

		for (const zone of zones) {
			if (zone.ref.current) {
				const rect = zone.ref.current.getBoundingClientRect();
				if (
					x >= rect.left &&
					x <= rect.right &&
					y >= rect.top &&
					y <= rect.bottom
				) {
					return zone.id;
				}
			}
		}
		return null;
	};

	const handleVideoDrop = (dropZoneId: "video1" | "video2") => {
		if (currentDragVideo) {
			setDroppedVideos((prev) => ({
				...prev,
				[dropZoneId]: currentDragVideo,
			}));
		}
	};

	const handleRemoveVideo = (dropZoneId: "video1" | "video2") => {
		setDroppedVideos((prev) => ({
			...prev,
			[dropZoneId]: null,
		}));
	};

	const isVideoInUse = (videoId: string) => {
		return droppedVideos.video1 === videoId || droppedVideos.video2 === videoId;
	};

	const checkVideoDropZone = (x: number, y: number): string | null => {
		const zones = [
			{ id: "video1", ref: video1Ref },
			{ id: "video2", ref: video2Ref },
		];

		for (const zone of zones) {
			if (zone.ref.current) {
				const rect = zone.ref.current.getBoundingClientRect();
				if (
					x >= rect.left &&
					x <= rect.right &&
					y >= rect.top &&
					y <= rect.bottom
				) {
					return zone.id;
				}
			}
		}
		return null;
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-[766px]">
				<DialogHeader
					description="Visualize data comparisons between each other"
					icon={<FontAwesomeIcon icon={faChartSimple} />}
				>
					<DialogTitle>Compare data</DialogTitle>
				</DialogHeader>
				<LayoutGroup>
					<div className="flex flex-1 w-full h-full">
						<FiltersList
							filters={FILTERS}
							isFilterInUse={isFilterInUse}
							onFilterDragStart={(value) => {
								setIsDragging(true);
								setCurrentDragValue(value);
							}}
							onFilterDragEnd={(x, y) => {
								setIsDragging(false);
								const dropZone = checkDropZone(x, y);
								if (dropZone) {
									handleDrop(dropZone as "compare" | "compareTwo");
								}
								setCurrentDragValue(null);
							}}
							onFilterDrag={(x, y) => setDragPosition({ x, y })}
						/>
						{/*Main side*/}
						<div className="flex flex-col flex-1 h-full">
							<div className="border-b border-gray-4 bg-gray-3">
								<p className="px-4 py-2 text-xs font-medium text-gray-12 will-change-auto">
									Analysis
								</p>
							</div>
							<div className="flex flex-col flex-1 gap-5 justify-between p-4">
								<div className="space-y-5">
									<div className="flex justify-evenly items-end px-4 py-3 w-full rounded-full border bg-gray-3 border-gray-5">
										<div className="flex flex-1 gap-2 items-center border-r border-gray-6">
											<p className="text-[13px] font-medium text-gray-11 will-change-auto">
												Compare
											</p>
											{/* biome-ignore lint: Static ID for drop zone identification */}
											<CompareDataDroppable
												id="compare"
												ref={compareRef}
												droppedValue={droppedItems.compare}
												onRemove={() => handleRemoveItem("compare")}
												isDragging={isDragging}
												dragPosition={dragPosition}
											/>
										</div>
										<div className="flex flex-1 gap-2 justify-end items-center">
											<p className="text-[13px] font-medium text-gray-11 will-change-auto">
												with
											</p>
											{/* biome-ignore lint: Static ID for drop zone identification */}
											<CompareDataDroppable
												id="compareTwo"
												ref={compareTwoRef}
												droppedValue={droppedItems.compareTwo}
												onRemove={() => handleRemoveItem("compareTwo")}
												isDragging={isDragging}
												dragPosition={dragPosition}
											/>
										</div>
									</div>
									<VideosPicker
										droppedVideos={droppedVideos}
										onRemoveVideo={handleRemoveVideo}
										isDragging={isVideoDragging}
										dragPosition={videoDragPosition}
										video1Ref={video1Ref}
										video2Ref={video2Ref}
									/>
								</div>
								<Button className="w-full" size="sm" variant="dark">
									Compare
								</Button>
							</div>
						</div>
						{/*Videos Picker*/}
						<CompareVideos
							videos={VIDEOS}
							isVideoInUse={isVideoInUse}
							onVideoDragStart={(videoId) => {
								setIsVideoDragging(true);
								setCurrentDragVideo(videoId);
							}}
							onVideoDragEnd={(x, y) => {
								setIsVideoDragging(false);
								const dropZone = checkVideoDropZone(x, y);
								if (dropZone) {
									handleVideoDrop(dropZone as "video1" | "video2");
								}
								setCurrentDragVideo(null);
							}}
							onVideoDrag={(x, y) => setVideoDragPosition({ x, y })}
						/>
					</div>
				</LayoutGroup>
			</DialogContent>
		</Dialog>
	);
};
