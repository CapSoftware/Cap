import { LogoSpinner } from "@inflight/ui";
import type { Video } from "@inflight/web-domain";
import clsx from "clsx";
import { Effect } from "effect";
import moment from "moment";
import Image from "next/image";
import { memo, useEffect, useRef } from "react";
import { useEffectQuery } from "@/lib/EffectRuntime";
import { ThumbnailRequest } from "@/lib/Requests/ThumbnailRequest";

export type ImageLoadingStatus = "loading" | "success" | "error";

interface VideoThumbnailProps {
	videoId: Video.VideoId;
	alt: string;
	imageClass?: string;
	objectFit?: string;
	containerClass?: string;
	videoDuration?: number;
	imageStatus: ImageLoadingStatus;
	setImageStatus: (status: ImageLoadingStatus) => void;
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

export const useThumnailQuery = (videoId: Video.VideoId) => {
	return useEffectQuery({
		queryKey: ThumbnailRequest.queryKey(videoId),
		queryFn: Effect.fn(function* () {
			return yield* Effect.request(
				new ThumbnailRequest.ThumbnailRequest({ videoId }),
				yield* ThumbnailRequest.DataLoaderResolver,
			);
		}),
	});
};

export const VideoThumbnail: React.FC<VideoThumbnailProps> = memo(
	({
		videoId,
		alt,
		imageClass,
		objectFit = "cover",
		containerClass,
		videoDuration,
		imageStatus,
		setImageStatus,
	}) => {
		const thumbnailUrl = useThumnailQuery(videoId);
		const imageRef = useRef<HTMLImageElement>(null);

		const randomGradient = `linear-gradient(to right, ${generateRandomGrayScaleColor()}, ${generateRandomGrayScaleColor()})`;

		useEffect(() => {
			if (imageRef.current?.complete && imageRef.current.naturalWidth !== 0) {
				setImageStatus("success");
			}
		}, [setImageStatus]);

		return (
			<div
				className={clsx(
					`overflow-hidden relative mx-auto w-full h-full bg-black rounded-t-xl border-b border-gray-3 aspect-video`,
					containerClass,
				)}
			>
				<div className="flex absolute inset-0 z-10 justify-center items-center">
					{thumbnailUrl.isError || imageStatus === "error" ? (
						<div
							className="w-full h-full"
							style={{ backgroundImage: randomGradient }}
						/>
					) : (
						(thumbnailUrl.isPending || imageStatus === "loading") && (
							<LogoSpinner className="w-5 h-auto animate-spin md:w-8" />
						)
					)}
				</div>
				{thumbnailUrl.data && (
					<Image
						ref={imageRef}
						src={thumbnailUrl.data}
						unoptimized
						fill={true}
						sizes="(max-width: 768px) 100vw, 33vw"
						alt={alt}
						key={videoId}
						style={{ objectFit: objectFit as any }}
						className={clsx(
							"w-full h-full rounded-t-xl",
							imageClass,
							imageStatus === "loading" && "opacity-0",
						)}
						onLoad={() => setImageStatus("success")}
						onError={() => setImageStatus("error")}
					/>
				)}
				{videoDuration && (
					<p className="text-white leading-0 px-2 left-3 rounded-full backdrop-blur-sm absolute z-10 bottom-3 bg-black/50 text-[11px]">
						{formatDuration(videoDuration)}
					</p>
				)}
			</div>
		);
	},
);
