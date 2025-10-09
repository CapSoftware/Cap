import { faHome, faRecordVinyl } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Minus, Plus } from "lucide-react";
import moment from "moment";
import type React from "react";
import { memo, useState } from "react";
import { useTheme } from "@/app/(org)/dashboard/Contexts";
import { Tooltip } from "@/components/Tooltip";
import {
	type ImageLoadingStatus,
	VideoThumbnail,
} from "@/components/VideoThumbnail";
import type { VideoData } from "./AddVideosDialogBase";

interface VideoCardProps {
	video: VideoData;
	isSelected: boolean;
	onToggle: () => void;
	isAlreadyInEntity: boolean;
	className?: string;
}

const VideoCard: React.FC<VideoCardProps> = memo(
	({ video, isSelected, onToggle, isAlreadyInEntity, className }) => {
		const { theme } = useTheme();
		const effectiveDate = video.metadata?.customCreatedAt
			? new Date(video.metadata.customCreatedAt)
			: video.createdAt;

		const [imageStatus, setImageStatus] =
			useState<ImageLoadingStatus>("loading");

		const folderColor = video.folderColor || "normal";
		const artboard =
			theme === "dark" && folderColor === "normal"
				? "folder"
				: folderColor === "normal"
					? "folder-dark"
					: `folder-${folderColor}`;

		const { RiveComponent: FolderRive } = useRive({
			src: "/rive/dashboard.riv",
			artboard,
			animations: "idle",
			autoplay: true,
			layout: new Layout({
				fit: Fit.Contain,
			}),
		});

		return (
			<div
				onClick={onToggle}
				role="button"
				tabIndex={0}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onToggle();
					}
				}}
				className={clsx(
					"flex relative flex-col p-3 w-full h-full rounded-xl border transition-all duration-200 group",
					className,
					isAlreadyInEntity && isSelected && "border-red-500",
					isAlreadyInEntity && !isSelected && "border-blue-500",
					!isAlreadyInEntity && isSelected && "border-green-500",
					!isAlreadyInEntity && !isSelected && "border-gray-4",
					isAlreadyInEntity
						? "bg-gray-3"
						: isSelected
							? "bg-gray-3"
							: "bg-transparent cursor-pointer hover:bg-gray-3 hover:border-gray-5",
				)}
			>
				<motion.div
					animate={{
						scale: isSelected || isAlreadyInEntity ? 1 : 0,
					}}
					initial={false}
					transition={{
						type: "spring",
						duration: 0.2,
					}}
					className={clsx(
						"flex absolute -top-2 -right-2 z-10 justify-center items-center rounded-full size-5",
						isSelected && isAlreadyInEntity && "bg-red-500",
						isSelected && !isAlreadyInEntity && "bg-green-500",
						!isSelected && isAlreadyInEntity && "bg-blue-500",
					)}
				>
					{/* Use AnimatePresence to properly handle icon transitions */}
					<AnimatePresence mode="wait" initial={false}>
						{isSelected && isAlreadyInEntity ? (
							<motion.div
								key="minus"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.1 }}
							>
								<Minus className="text-white" size={14} />
							</motion.div>
						) : isSelected && !isAlreadyInEntity ? (
							<motion.div
								key="check"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.1 }}
							>
								<Check className="text-white" size={14} />
							</motion.div>
						) : (
							isAlreadyInEntity && (
								<motion.div
									key="plus"
									initial={{ opacity: 0 }}
									animate={{ opacity: 1 }}
									exit={{ opacity: 0 }}
									transition={{ duration: 0.1 }}
								>
									<Plus className="text-white" size={14} />
								</motion.div>
							)
						)}
					</AnimatePresence>
				</motion.div>

				<div
					className={clsx(
						"overflow-visible relative mb-2 w-full h-32 rounded-lg border transition-colors bg-gray-3 border-gray-5",
					)}
				>
					<VideoThumbnail
						imageClass="w-full h-full transition-all duration-200 group-hover:scale-105"
						videoId={video.id}
						alt={`${video.name} Thumbnail`}
						objectFit="cover"
						containerClass="!h-full !rounded-lg !border-b-0"
						imageStatus={imageStatus}
						setImageStatus={setImageStatus}
					/>
				</div>

				<div className="space-y-2 min-h-fit">
					<div className="flex flex-col gap-1">
						<Tooltip content={video.name}>
							<h3
								className={clsx(
									"text-sm font-medium leading-tight truncate text-gray-12",
								)}
							>
								{video.name}
							</h3>
						</Tooltip>
						<p className="text-xs text-gray-10">
							{moment(effectiveDate).format("MMM D, YYYY")}
						</p>
					</div>
					<div className="flex gap-1 items-center text-xs text-gray-10">
						{video.folderName ? (
							<>
								<FolderRive
									key={theme + folderColor}
									color={folderColor}
									className="size-4"
								/>
								<p className="font-medium truncate text-gray-11">
									{video.folderName}
								</p>
							</>
						) : isAlreadyInEntity ? (
							<>
								<FontAwesomeIcon
									icon={faHome}
									className="size-3 text-gray-10"
								/>
								<p className="font-medium truncate text-gray-11">Root</p>
							</>
						) : (
							<>
								<FontAwesomeIcon
									icon={faRecordVinyl}
									className="size-3 text-gray-10"
								/>
								<p className="font-medium truncate text-gray-11">Caps</p>
							</>
						)}
					</div>
				</div>
			</div>
		);
	},
);

export default VideoCard;
