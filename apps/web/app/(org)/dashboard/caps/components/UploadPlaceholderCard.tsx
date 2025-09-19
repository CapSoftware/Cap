"use client";

import { LogoSpinner } from "@cap/ui";
import { getUploadStatus } from "@cap/utils";
import type { Video } from "@cap/web-domain";
import { faVideo } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import ProgressCircle, {
	useUploadProgress,
} from "@/app/s/[videoId]/_components/ProgressCircle";
import { useUploadingContext } from "../UploadingContext";

export const UploadPlaceholderCard = () => {
	const { uploadingCapId, uploadingThumbnailUrl, uploadProgress } =
		useUploadingContext();
	const status = getUploadStatus(uploadProgress);

	// Always call useUploadProgress hook, but pass empty string when no capId
	const progressStatus = useUploadProgress(
		(uploadingCapId as Video.VideoId) || ("" as Video.VideoId),
		!!uploadingCapId,
	);

	return (
		<div className="flex relative transition-colors duration-200 flex-col gap-4 w-full h-full rounded-xl cursor-default bg-gray-1 border border-gray-3 group border-px">
			<div className="relative">
				<div className="overflow-hidden relative w-full bg-black rounded-t-xl aspect-video">
					{uploadingThumbnailUrl ? (
						// eslint-disable-next-line @next/next/no-img-element
						<img
							src={uploadingThumbnailUrl}
							alt="Uploading thumbnail"
							className="object-cover w-full h-full opacity-30 transition-opacity duration-200"
						/>
					) : (
						<div className="flex justify-center items-center w-full h-full">
							<LogoSpinner className="w-8 h-8 animate-spin" />
						</div>
					)}
				</div>

				<div className="flex absolute inset-0 z-50 justify-center items-center bg-black rounded-t-xl">
					{progressStatus && uploadingCapId ? (
						<UploadCircleWithProgress progress={progressStatus} />
					) : status === "Processing" ? (
						<div className="relative size-20 md:size-16">
							<ProgressCircle
								progressTextClassName="md:!text-[11px]"
								subTextClassName="!mt-0 md:!text-[7px] !text-[10px] mb-1"
								className="md:scale-[1.5] scale-[1.2]"
								progress={0}
								subText="Processing..."
							/>
						</div>
					) : status === "Uploading" ? (
						<div className="relative size-20 md:size-16">
							<ProgressCircle
								progressTextClassName="md:!text-[11px]"
								subTextClassName="!mt-0 md:!text-[7px] !text-[10px] mb-1"
								className="md:scale-[1.5] scale-[1.2]"
								progress={0}
							/>
						</div>
					) : (
						<div className="relative size-20 md:size-16">
							<ProgressCircle
								progressTextClassName="md:!text-[11px]"
								subTextClassName="!mt-0 md:!text-[7px] !text-[10px] mb-1"
								className="md:scale-[1.5] scale-[1.2]"
								progress={0}
							/>
						</div>
					)}
				</div>
			</div>

			<div className="flex flex-col flex-grow gap-3 px-4 pb-4 w-full">
				<div>
					<div className="h-[1.25rem] mb-1">
						<div className="h-4 rounded animate-pulse bg-gray-3" />
					</div>
					<div className="mb-1 h-[1.25rem]">
						<div className="w-24 h-3 rounded animate-pulse bg-gray-3" />
					</div>
					<div className="mb-1 h-[1.5rem]">
						<div className="w-20 h-3 rounded animate-pulse bg-gray-3" />
					</div>
				</div>
				<div className="flex gap-4 items-center text-sm text-gray-10">
					<div className="w-16 h-3 rounded animate-pulse bg-gray-3" />
				</div>
			</div>
		</div>
	);
};

function UploadCircleWithProgress(props: {
	progress: ReturnType<typeof useUploadProgress>;
}) {
	const { progress } = props;

	if (!progress) {
		return (
			<div className="relative size-20 md:size-16">
				<ProgressCircle
					progressTextClassName="md:!text-[11px]"
					subTextClassName="!mt-0 md:!text-[7px] !text-[10px] mb-1"
					className="md:scale-[1.5] scale-[1.2]"
					progress={0}
				/>
			</div>
		);
	}

	if (progress.status === "failed") {
		return (
			<div className="flex flex-col items-center">
				<div className="flex justify-center items-center mb-2 w-8 h-8 bg-red-500 rounded-full">
					<FontAwesomeIcon icon={faVideo} className="text-white size-3" />
				</div>
				<p className="text-xs text-center text-white">Upload failed</p>
			</div>
		);
	}

	return (
		<div className="relative size-20 md:size-16">
			<ProgressCircle
				progressTextClassName="md:!text-[11px]"
				subTextClassName="!mt-0 md:!text-[7px] !text-[10px] mb-1"
				className="md:scale-[1.5] scale-[1.2]"
				progress={progress.status === "uploading" ? progress.progress : 0}
			/>
		</div>
	);
}
