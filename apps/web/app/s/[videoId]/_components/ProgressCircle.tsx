"use client";

import type { Video } from "@cap/web-domain";
import clsx from "clsx";
import { Effect, Option } from "effect";
import { useEffectQuery, useRpcClient } from "@/lib/EffectRuntime";

type UploadProgress =
	| { status: "fetching" }
	| {
			status: "uploading";
			lastUpdated: Date;
			progress: number;
	  }
	| {
			status: "processing";
			lastUpdated: Date;
			progress: number;
			message: string | null;
	  }
	| {
			status: "generating_thumbnail";
			lastUpdated: Date;
			progress: number;
	  }
	| {
			status: "error";
			lastUpdated: Date;
			errorMessage: string | null;
	  }
	| {
			status: "failed";
			lastUpdated: Date;
	  };

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;

export function useUploadProgress(
	videoId: Video.VideoId,
	enabled: boolean,
): UploadProgress | null {
	const rpc = useRpcClient();

	const query = useEffectQuery({
		queryKey: ["getUploadProgress", videoId],
		queryFn: () =>
			rpc
				.GetUploadProgress(videoId)
				.pipe(Effect.map((v) => Option.getOrNull(v ?? Option.none()))),
		enabled,
		refetchInterval: (query) => {
			if (!enabled || !query.state.data) return false;

			const timeSinceUpdate = Date.now() - query.state.data.updatedAt.getTime();
			if (timeSinceUpdate > DAY) return 30 * SECOND;
			if (timeSinceUpdate > HOUR) return 15 * SECOND;
			else if (timeSinceUpdate > 5 * MINUTE) return 5 * SECOND;
			else return SECOND;
		},
	});

	if (!enabled) return null;
	if (query.isPending) return { status: "fetching" };
	if (!query.data) return null;

	const lastUpdated = new Date(query.data.updatedAt);
	const phase = query.data.phase;

	if (phase === "complete") return null;

	if (phase === "error") {
		return {
			status: "error",
			lastUpdated,
			errorMessage: Option.getOrNull(query.data.processingError),
		};
	}

	if (phase === "processing") {
		return {
			status: "processing",
			lastUpdated,
			progress: query.data.processingProgress,
			message: Option.getOrNull(query.data.processingMessage),
		};
	}

	if (phase === "generating_thumbnail") {
		return {
			status: "generating_thumbnail",
			lastUpdated,
			progress: query.data.processingProgress,
		};
	}

	const isUploadComplete =
		query.data.total > 0 && query.data.uploaded >= query.data.total;
	if (isUploadComplete) return null;

	if (Date.now() - lastUpdated.getTime() > 5 * MINUTE) {
		return {
			status: "failed",
			lastUpdated,
		};
	}

	return {
		status: "uploading",
		lastUpdated,
		progress:
			query.data.total === 0
				? 0
				: (query.data.uploaded / query.data.total) * 100,
	};
}

const ProgressCircle = ({
	progress,
	status = "uploading",
	message,
	className,
	progressTextClassName,
	subTextClassName,
}: {
	progress: number;
	status?: "uploading" | "processing" | "generating_thumbnail";
	message?: string | null;
	className?: string;
	progressTextClassName?: string;
	subTextClassName?: string;
}) => {
	const strokeColor = status === "uploading" ? "#3b82f6" : "#22c55e";

	const getStatusText = () => {
		switch (status) {
			case "processing":
				return message || "Processing...";
			case "generating_thumbnail":
				return "Generating thumbnail...";
			default:
				return "Uploading...";
		}
	};

	return (
		<div
			className={clsx(
				"relative scale-100 size-full sm:scale-110 md:scale-[1.3]",
				className,
			)}
		>
			<svg className="transform -rotate-90 size-full" viewBox="0 0 100 100">
				<title>Progress Circle</title>
				<circle
					cx="50"
					cy="50"
					r="45"
					fill="none"
					stroke="rgba(255, 255, 255, 0.2)"
					strokeWidth="5"
				/>
				<circle
					cx="50"
					cy="50"
					r="45"
					fill="none"
					stroke={strokeColor}
					strokeWidth="5"
					strokeLinecap="round"
					strokeDasharray={`${2 * Math.PI * 45}`}
					strokeDashoffset={`${2 * Math.PI * 45 * (1 - progress / 100)}`}
					className="transition-all duration-300 ease-out"
				/>
			</svg>

			<div className="flex absolute inset-0 flex-col justify-center items-center p-2">
				<p
					className={clsx(
						"text-sm font-semibold tabular-nums md:leading-tight leading-tight text-white xs:text-sm md:text-lg",
						progressTextClassName,
					)}
				>
					{Math.round(progress)}%
				</p>
				<p
					className={clsx(
						"mt-0.5 leading-tight text-[10px] text-white/80 text-center",
						subTextClassName,
					)}
				>
					{getStatusText()}
				</p>
			</div>
		</div>
	);
};

export default ProgressCircle;
