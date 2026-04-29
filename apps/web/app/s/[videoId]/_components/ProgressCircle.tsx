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
			hasRawFallback: boolean;
	  }
	| {
			status: "failed";
			lastUpdated: Date;
	  };

export function shouldDeferPlaybackSource(
	uploadProgress: UploadProgress | null,
): boolean {
	return (
		uploadProgress?.status === "fetching" ||
		uploadProgress?.status === "uploading"
	);
}

export function shouldReloadPlaybackAfterUploadCompletes(
	previousUploadProgress: UploadProgress | null,
	uploadProgress: UploadProgress | null,
	videoLoaded: boolean,
): boolean {
	return (
		previousUploadProgress !== null &&
		previousUploadProgress.status !== "fetching" &&
		uploadProgress === null &&
		!videoLoaded
	);
}

export function canRetryFailedProcessing(
	uploadProgress: UploadProgress | null,
	canRetryProcessing: boolean,
): boolean {
	return canRetryProcessing && uploadProgress?.status === "error";
}

export function getUploadFailureMessage(
	uploadProgress: UploadProgress | null,
	canRetryProcessing: boolean,
): string {
	if (uploadProgress?.status === "error") {
		if (canRetryFailedProcessing(uploadProgress, canRetryProcessing)) {
			return uploadProgress.errorMessage || "Processing failed.";
		}

		return (
			uploadProgress.errorMessage ||
			"Processing failed. Ask the owner to retry processing or re-upload the recording."
		);
	}

	return "Upload stalled before processing finished. Re-upload the recording to continue.";
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;
const STALE_PROCESSING_START_MS = 90 * SECOND;
const STALE_PROCESSING_PROGRESS_MS = 10 * MINUTE;
const STALE_THUMBNAIL_MS = 5 * MINUTE;

export function getStalledProcessingMessage(input: {
	phase:
		| "uploading"
		| "processing"
		| "generating_thumbnail"
		| "complete"
		| "error";
	updatedAt: Date;
	processingProgress: number;
}): string | null {
	const ageMs = Date.now() - input.updatedAt.getTime();

	if (input.phase === "processing") {
		if (input.processingProgress === 0 && ageMs > STALE_PROCESSING_START_MS) {
			return "Video processing did not start. Retry processing.";
		}

		if (ageMs > STALE_PROCESSING_PROGRESS_MS) {
			return "Video processing stalled. Retry processing.";
		}
	}

	if (input.phase === "generating_thumbnail" && ageMs > STALE_THUMBNAIL_MS) {
		return "Video finishing stalled. Retry processing.";
	}

	return null;
}

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
	const stalledProcessingMessage = getStalledProcessingMessage({
		phase,
		updatedAt: lastUpdated,
		processingProgress: query.data.processingProgress,
	});

	if (phase === "complete") return null;

	if (phase === "error") {
		return {
			status: "error",
			lastUpdated,
			errorMessage: Option.getOrNull(query.data.processingError),
			hasRawFallback: query.data.hasRawFallback,
		};
	}

	if (stalledProcessingMessage) {
		return {
			status: "error",
			lastUpdated,
			errorMessage: stalledProcessingMessage,
			hasRawFallback: query.data.hasRawFallback,
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
	className,
	progressTextClassName,
	subTextClassName,
}: {
	progress: number;
	status?: "uploading" | "processing" | "generating_thumbnail";
	className?: string;
	progressTextClassName?: string;
	subTextClassName?: string;
}) => {
	const strokeColor = status === "uploading" ? "#3b82f6" : "#22c55e";

	const getStatusText = () => {
		switch (status) {
			case "processing":
				return "Processing";
			case "generating_thumbnail":
				return "Finishing up";
			default:
				return "Uploading";
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
