"use client";

import { LogoSpinner } from "@inflight/ui";
import {
	calculateStrokeDashoffset,
	getProgressCircleConfig,
} from "@inflight/utils";
import { useStore } from "@tanstack/react-store";
import { type UploadStatus, useUploadingContext } from "../UploadingContext";

const { circumference } = getProgressCircleConfig();

export const UploadPlaceholderCard = () => {
	const { uploadingStore } = useUploadingContext();
	const uploadStatus = useStore(uploadingStore, (s) => s.uploadStatus);
	const strokeDashoffset = calculateStrokeDashoffset(
		uploadStatus &&
			(uploadStatus.status === "converting" ||
				uploadStatus.status === "uploadingThumbnail" ||
				uploadStatus.status === "uploadingVideo")
			? uploadStatus.progress
			: 0,
		circumference,
	);

	if (!uploadStatus) return null;
	return (
		<div className="flex flex-col gap-4 w-full h-full rounded-xl bg-gray-1 border-gray-3 border-[1px]">
			<div className="overflow-hidden relative w-full bg-black rounded-t-xl border-b border-gray-3 aspect-video group">
				{uploadStatus.status === "uploadingVideo" ? (
					<img
						src={uploadStatus.thumbnailUrl}
						alt="Uploading thumbnail"
						className="object-cover w-full h-full"
					/>
				) : (
					<div className="flex justify-center items-center w-full h-full">
						<LogoSpinner className="w-8 h-8 animate-spin" />
					</div>
				)}

				<div className="absolute inset-0 transition-all duration-300 bg-black/60"></div>

				<div className="flex absolute bottom-3 left-3 gap-2 items-center">
					<span className="text-sm font-semibold text-white">
						{getFriendlyStatus(uploadStatus.status)}
					</span>
					<svg className="w-4 h-4 transform -rotate-90" viewBox="0 0 20 20">
						<circle
							cx="10"
							cy="10"
							r="8"
							stroke="currentColor"
							strokeWidth="3"
							fill="none"
							className="text-white/30"
						/>
						<circle
							cx="10"
							cy="10"
							r="8"
							stroke="currentColor"
							strokeWidth="3"
							fill="none"
							strokeLinecap="round"
							className="text-white transition-all duration-200 ease-out"
							style={{
								strokeDasharray: `${circumference} ${circumference}`,
								strokeDashoffset: `${strokeDashoffset}`,
							}}
						/>
					</svg>
				</div>
			</div>
			<div className="flex flex-col flex-grow gap-3 px-4 pb-4 w-full">
				<div>
					<div className="h-[1.25rem] mb-1">
						<div className="h-4 rounded animate-pulse bg-gray-3"></div>
					</div>
					<div className="mb-1 h-[1.25rem]">
						<div className="w-24 h-3 rounded animate-pulse bg-gray-3"></div>
					</div>
					<div className="mb-1 h-[1.5rem]">
						<div className="w-20 h-3 rounded animate-pulse bg-gray-3"></div>
					</div>
				</div>
				<div className="flex gap-4 items-center text-sm text-gray-10">
					<div className="w-16 h-3 rounded animate-pulse bg-gray-3"></div>
				</div>
			</div>
		</div>
	);
};

function getFriendlyStatus(status: UploadStatus["status"]) {
	switch (status) {
		case "parsing":
			return "Parsing";
		case "creating":
			return "Creating";
		case "converting":
			return "Converting";
		case "uploadingThumbnail":
		case "uploadingVideo":
			return "Uploading";
		default:
			return "Processing...";
	}
}
