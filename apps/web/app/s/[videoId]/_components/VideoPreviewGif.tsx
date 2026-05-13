"use client";

import type { Video } from "@cap/web-domain";
import clsx from "clsx";
import Image from "next/image";
import { useState } from "react";

interface VideoPreviewGifProps {
	videoId: Video.VideoId;
	visible: boolean;
	className?: string;
}

function getPreviewGifSrc(videoId: Video.VideoId) {
	return `/api/video/preview?videoId=${encodeURIComponent(videoId)}&fallback=none`;
}

export function VideoPreviewGif({
	videoId,
	visible,
	className,
}: VideoPreviewGifProps) {
	const [status, setStatus] = useState<"loading" | "loaded" | "error">(
		"loading",
	);

	if (!visible || status === "error") return null;

	return (
		<Image
			key={videoId}
			src={getPreviewGifSrc(videoId)}
			alt=""
			aria-hidden="true"
			unoptimized
			fill
			sizes="(max-width: 768px) 100vw, 75vw"
			priority
			draggable={false}
			className={clsx(
				"object-contain absolute inset-0 z-[5] w-full h-full pointer-events-none transition-opacity duration-200",
				status === "loaded" ? "opacity-100" : "opacity-0",
				className,
			)}
			onLoad={() => setStatus("loaded")}
			onError={() => setStatus("error")}
		/>
	);
}
