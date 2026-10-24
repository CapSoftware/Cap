"use client";

import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { faComment, faLock, faSmile } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import Link from "next/link";
import { useState } from "react";
import {
	type ImageLoadingStatus,
	VideoThumbnail,
} from "@/components/VideoThumbnail";

type PublicCapCardVideo = {
	id: string;
	name: string;
	createdAt: Date | string;
	metadata: Pick<VideoMetadata, "customCreatedAt"> | undefined;
	duration: number | null;
	totalComments: number;
	totalReactions: number;
	ownerName: string;
	hasPassword: boolean;
	hasActiveUpload: boolean;
};

const relativeTimeFormatter = new Intl.RelativeTimeFormat("en", {
	numeric: "auto",
});
const relativeTimeUnits: {
	unit: Intl.RelativeTimeFormatUnit;
	seconds: number;
}[] = [
	{ unit: "year", seconds: 31536000 },
	{ unit: "month", seconds: 2592000 },
	{ unit: "week", seconds: 604800 },
	{ unit: "day", seconds: 86400 },
	{ unit: "hour", seconds: 3600 },
	{ unit: "minute", seconds: 60 },
	{ unit: "second", seconds: 1 },
];

function formatRelativeDate(date: Date, now: number) {
	const secondsFromNow = Math.round((date.getTime() - now) / 1000);
	const absoluteSeconds = Math.abs(secondsFromNow);
	const unit = relativeTimeUnits.find(
		({ seconds }) => absoluteSeconds >= seconds,
	) ?? { unit: "second", seconds: 1 };

	return relativeTimeFormatter.format(
		Math.round(secondsFromNow / unit.seconds),
		unit.unit,
	);
}

export function PublicCapCard({
	cap,
	now,
	layout = "grid",
}: {
	cap: PublicCapCardVideo;
	/**
	 * Server render timestamp, passed as a prop so the hydrated client render
	 * produces the same relative-date string as the server HTML.
	 */
	now: number;
	layout?: "grid" | "list";
}) {
	const [imageStatus, setImageStatus] = useState<ImageLoadingStatus>("loading");
	const effectiveDate = cap.metadata?.customCreatedAt
		? new Date(cap.metadata.customCreatedAt)
		: new Date(cap.createdAt);
	const subtitle = `${cap.ownerName || "Cap"} · ${formatRelativeDate(effectiveDate, now)}`;

	const lockBadge = cap.hasPassword && (
		<div className="flex absolute top-2 right-2 z-10 justify-center items-center rounded-full size-7 bg-black/70 text-white">
			<FontAwesomeIcon icon={faLock} className="size-3" />
		</div>
	);

	const stats = (
		<div className="flex gap-4 items-center text-sm text-gray-10">
			<span className="inline-flex gap-1.5 items-center">
				<FontAwesomeIcon icon={faComment} className="size-3.5" />
				{cap.totalComments}
			</span>
			<span className="inline-flex gap-1.5 items-center">
				<FontAwesomeIcon icon={faSmile} className="size-3.5" />
				{cap.totalReactions}
			</span>
		</div>
	);

	if (layout === "list") {
		return (
			<Link
				href={`/s/${cap.id}`}
				className="group flex gap-4 items-center p-3 rounded-xl border transition-colors border-gray-4 bg-gray-1 hover:border-gray-6"
			>
				<div className="overflow-hidden relative w-40 rounded-lg shrink-0 aspect-video bg-gray-3">
					<VideoThumbnail
						videoDuration={cap.duration ?? undefined}
						imageClass="transition-opacity duration-200 group-hover:opacity-80"
						containerClass="absolute inset-0 rounded-lg"
						videoId={cap.id as Video.VideoId}
						alt={`${cap.name} Thumbnail`}
						imageStatus={imageStatus}
						setImageStatus={setImageStatus}
						hasActiveUpload={cap.hasActiveUpload}
					/>
					{lockBadge}
				</div>
				<div className="flex flex-1 justify-between items-center min-w-0">
					<div className="min-w-0">
						<h3 className="text-base font-medium leading-6 truncate text-gray-12">
							{cap.name}
						</h3>
						<p className="text-sm leading-5 truncate text-gray-10">
							{subtitle}
						</p>
					</div>
					<div className="hidden shrink-0 sm:block">{stats}</div>
				</div>
			</Link>
		);
	}

	return (
		<Link
			href={`/s/${cap.id}`}
			className={clsx(
				"group flex flex-col h-full rounded-xl border transition-colors",
				"overflow-hidden border-gray-4 bg-gray-1 hover:border-gray-6",
			)}
		>
			<div className="overflow-hidden relative w-full aspect-video bg-gray-3">
				<VideoThumbnail
					videoDuration={cap.duration ?? undefined}
					imageClass="transition-opacity duration-200 group-hover:opacity-80"
					containerClass="absolute inset-0 rounded-t-xl"
					videoId={cap.id as Video.VideoId}
					alt={`${cap.name} Thumbnail`}
					imageStatus={imageStatus}
					setImageStatus={setImageStatus}
					hasActiveUpload={cap.hasActiveUpload}
				/>
				{lockBadge}
			</div>
			<div className="flex flex-col flex-1 gap-3 p-4">
				<div className="min-w-0">
					<h3 className="text-base font-medium leading-6 truncate text-gray-12">
						{cap.name}
					</h3>
					<p className="text-sm leading-5 truncate text-gray-10">{subtitle}</p>
				</div>
				<div className="mt-auto">{stats}</div>
			</div>
		</Link>
	);
}
