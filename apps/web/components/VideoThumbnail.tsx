import { LogoSpinner } from "@cap/ui";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import moment from "moment";
import Image from "next/image";
import { memo, useEffect, useRef, useState } from "react";
import { useUploadingContext } from "@/app/(org)/dashboard/caps/UploadingContext";

interface VideoThumbnailProps {
	userId: string;
	videoId: string;
	alt: string;
	imageClass?: string;
	objectFit?: string;
	containerClass?: string;
	videoDuration?: number;
}

const formatDuration = (durationSecs: number) => {
	const momentDuration = moment.duration(durationSecs, "seconds");

	const totalHours = Math.floor(momentDuration.asHours());
	const totalMinutes = Math.floor(momentDuration.asMinutes());
	const remainingSeconds = Math.ceil(momentDuration.asSeconds() % 60); // Use ceil to avoid 0 secs

	if (totalHours > 0) {
		return `${totalHours} hr${totalHours > 1 ? "s" : ""}`;
	} else if (totalMinutes > 0) {
		return `${totalMinutes} min${totalMinutes > 1 ? "s" : ""}`;
	} else if (remainingSeconds > 0) {
		return `${remainingSeconds} sec${remainingSeconds !== 1 ? "s" : ""}`;
	} else {
		return "< 1 sec"; // For very short durations
	}
};

function generateRandomGrayScaleColor() {
	const minGrayScaleValue = 190;
	const maxGrayScaleValue = 235;
	const grayScaleValue = Math.floor(
		Math.random() * (maxGrayScaleValue - minGrayScaleValue) + minGrayScaleValue,
	);
	return `rgb(${grayScaleValue}, ${grayScaleValue}, ${grayScaleValue})`;
}

export const VideoThumbnail: React.FC<VideoThumbnailProps> = memo(
	({
		userId,
		videoId,
		alt,
		imageClass,
		objectFit = "cover",
		containerClass,
		videoDuration,
	}) => {
		const imageUrl = useQuery({
			queryKey: ["thumbnail", userId, videoId],
			queryFn: async () => {
				const cacheBuster = new Date().getTime();
				const response = await fetch(
					`/api/thumbnail?userId=${userId}&videoId=${videoId}&t=${cacheBuster}`,
				);
				if (response.ok) {
					const data = await response.json();
					return data.screen;
				} else {
					throw new Error("Failed to fetch pre-signed URLs");
				}
			},
		});
		const imageRef = useRef<HTMLImageElement>(null);

		const { uploadingCapId } = useUploadingContext();

		useEffect(() => {
			imageUrl.refetch();
		}, [imageUrl.refetch, uploadingCapId]);

		const randomGradient = `linear-gradient(to right, ${generateRandomGrayScaleColor()}, ${generateRandomGrayScaleColor()})`;

		const [imageStatus, setImageStatus] = useState<
			"loading" | "error" | "success"
		>("loading");

		useEffect(() => {
			if (imageRef.current?.complete && imageRef.current.naturalWidth != 0) {
				setImageStatus("success");
			}
		}, []);

		return (
			<div
				className={clsx(
					`overflow-hidden relative mx-auto w-full h-full bg-black rounded-t-xl border-b border-gray-3 aspect-video`,
					containerClass,
				)}
			>
				<div className="flex absolute inset-0 z-10 justify-center items-center">
					{imageUrl.isError || imageStatus === "error" ? (
						<div
							className="w-full h-full"
							style={{ backgroundImage: randomGradient }}
						/>
					) : (
						(imageUrl.isPending || imageStatus === "loading") && (
							<LogoSpinner className="w-5 h-auto animate-spin md:w-8" />
						)
					)}
				</div>
				{videoDuration && (
					<p className="text-white leading-0 px-2 left-3 rounded-full backdrop-blur-sm absolute z-10 bottom-3 bg-black/50 text-[11px]">
						{formatDuration(videoDuration)}
					</p>
				)}
				{imageUrl.data && (
					<Image
						ref={imageRef}
						src={imageUrl.data}
						fill={true}
						sizes="(max-width: 768px) 100vw, 33vw"
						alt={alt}
						key={videoId}
						style={{ objectFit: objectFit as any }}
						className={clsx(
							"w-full h-full",
							imageClass,
							imageStatus === "loading" && "opacity-0",
						)}
						onLoad={() => setImageStatus("success")}
						onError={() => setImageStatus("error")}
					/>
				)}
			</div>
		);
	},
);
