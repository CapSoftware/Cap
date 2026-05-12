import { LogoSpinner } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import clsx from "clsx";
import { Effect } from "effect";
import moment from "moment";
import Image from "next/image";
import type { CSSProperties } from "react";
import { memo, useEffect, useRef, useState } from "react";
import { useEffectQuery } from "@/lib/EffectRuntime";
import { ThumbnailRequest } from "@/lib/Requests/ThumbnailRequest";

export type ImageLoadingStatus = "loading" | "success" | "error";

type PreviewState = {
	videoId: Video.VideoId;
	hovered: boolean;
	status: ImageLoadingStatus;
};

interface VideoThumbnailProps {
	videoId: Video.VideoId;
	alt: string;
	imageClass?: string;
	objectFit?: CSSProperties["objectFit"];
	containerClass?: string;
	videoDuration?: number;
	imageStatus: ImageLoadingStatus;
	setImageStatus: (status: ImageLoadingStatus) => void;
	hasActiveUpload?: boolean;
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

function getPreviewGifSrc(videoId: Video.VideoId) {
	return `/api/video/preview?videoId=${encodeURIComponent(videoId)}&fallback=none`;
}

export const useThumnailQuery = (
	videoId: Video.VideoId,
	enabled: boolean = true,
) => {
	return useEffectQuery({
		queryKey: ThumbnailRequest.queryKey(videoId),
		queryFn: Effect.fn(function* () {
			return yield* Effect.request(
				new ThumbnailRequest.ThumbnailRequest({ videoId }),
				yield* ThumbnailRequest.DataLoaderResolver,
			);
		}),
		enabled,
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
		hasActiveUpload = false,
	}) => {
		const thumbnailUrl = useThumnailQuery(videoId, !hasActiveUpload);
		const containerRef = useRef<HTMLDivElement>(null);
		const imageRef = useRef<HTMLImageElement>(null);
		const latestVideoId = useRef(videoId);
		const [previewState, setPreviewState] = useState<PreviewState>(() => ({
			videoId,
			hovered: false,
			status: "loading",
		}));
		latestVideoId.current = videoId;

		const randomGradient = `linear-gradient(to right, ${generateRandomGrayScaleColor()}, ${generateRandomGrayScaleColor()})`;

		useEffect(() => {
			if (imageRef.current?.complete && imageRef.current.naturalWidth !== 0) {
				setImageStatus("success");
			}
		}, [setImageStatus]);

		useEffect(() => {
			const element = containerRef.current;
			if (!element) return;

			const setHovered = (hovered: boolean) => {
				const currentVideoId = latestVideoId.current;
				setPreviewState((state) => ({
					videoId: currentVideoId,
					hovered,
					status: state.videoId === currentVideoId ? state.status : "loading",
				}));
			};

			const handleMouseEnter = () => setHovered(true);
			const handleMouseLeave = () => setHovered(false);

			element.addEventListener("mouseenter", handleMouseEnter);
			element.addEventListener("mouseleave", handleMouseLeave);

			return () => {
				element.removeEventListener("mouseenter", handleMouseEnter);
				element.removeEventListener("mouseleave", handleMouseLeave);
			};
		}, []);

		const showError =
			!hasActiveUpload && (thumbnailUrl.isError || imageStatus === "error");
		const showLoading =
			hasActiveUpload || thumbnailUrl.isPending || imageStatus === "loading";
		const previewStatus =
			previewState.videoId === videoId ? previewState.status : "loading";
		const isPreviewHovered =
			previewState.videoId === videoId && previewState.hovered;
		const showPreview =
			isPreviewHovered && !hasActiveUpload && previewStatus !== "error";
		const setCurrentPreviewStatus = (status: ImageLoadingStatus) => {
			setPreviewState((state) => ({
				videoId,
				hovered: state.videoId === videoId ? state.hovered : false,
				status,
			}));
		};

		return (
			<div
				ref={containerRef}
				className={clsx(
					`overflow-hidden relative mx-auto w-full h-full bg-black rounded-t-xl border-b border-gray-3 aspect-video`,
					containerClass,
				)}
			>
				<div className="flex absolute inset-0 z-10 justify-center items-center">
					{showError ? (
						<div
							className="w-full h-full"
							style={{ backgroundImage: randomGradient }}
						/>
					) : (
						showLoading &&
						!thumbnailUrl.data && (
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
						style={{ objectFit }}
						className={clsx(
							"w-full h-full rounded-t-xl",
							imageClass,
							imageStatus === "loading" && "opacity-0",
						)}
						onLoad={() => setImageStatus("success")}
						onError={() => setImageStatus("error")}
					/>
				)}
				{showPreview && (
					<Image
						key={`${videoId}-preview`}
						src={getPreviewGifSrc(videoId)}
						alt=""
						aria-hidden="true"
						unoptimized
						fill={true}
						loading="lazy"
						sizes="(max-width: 768px) 100vw, 33vw"
						className={clsx(
							"object-cover absolute inset-0 z-20 w-full h-full rounded-t-xl transition-opacity duration-150",
							previewStatus === "success" ? "opacity-100" : "opacity-0",
						)}
						onLoad={() => setCurrentPreviewStatus("success")}
						onError={() => setCurrentPreviewStatus("error")}
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
