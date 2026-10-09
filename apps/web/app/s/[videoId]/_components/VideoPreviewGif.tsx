"use client";

import type { Video } from "@cap/web-domain";
import clsx from "clsx";
import Image from "next/image";
import { useState } from "react";

interface VideoPreviewGifProps {
	videoId: Video.VideoId;
	visible: boolean;
	preload?: boolean;
	className?: string;
}

function getPreviewGifSrc(videoId: Video.VideoId) {
	return `/api/video/preview?videoId=${encodeURIComponent(videoId)}&fallback=none`;
}

export function VideoPreviewGif({
	videoId,
	visible,
	preload = visible,
	className,
}: VideoPreviewGifProps) {
	if (!preload && !visible) return null;

	return (
		<PreviewGifImage
			key={videoId}
			videoId={videoId}
			visible={visible}
			className={className}
		/>
	);
}

function PreviewGifImage({
	videoId,
	visible,
	className,
}: VideoPreviewGifProps) {
	const [status, setStatus] = useState<"loading" | "loaded" | "error">(
		"loading",
	);

	if (status === "error") return null;

	return (
		<Image
			src={getPreviewGifSrc(videoId)}
			alt=""
			aria-hidden="true"
			unoptimized
			fill
			sizes="(max-width: 768px) 100vw, 75vw"
			loading="eager"
			fetchPriority="high"
			draggable={false}
			className={clsx(
				"object-contain absolute inset-0 z-[5] w-full h-full pointer-events-none transition-opacity duration-200",
				visible && status === "loaded" ? "opacity-100" : "opacity-0",
				className,
			)}
			onLoad={() => setStatus("loaded")}
			onError={() => setStatus("error")}
		/>
	);
}
