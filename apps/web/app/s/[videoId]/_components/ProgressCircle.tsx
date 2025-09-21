"use client";

import type { Video } from "@cap/web-domain";
import clsx from "clsx";
import { Effect, Option } from "effect";
import { useEffectQuery } from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";

type UploadProgress =
	| {
			status: "uploading";
			lastUpdated: Date;
			progress: number;
	  }
	| {
			status: "failed";
			lastUpdated: Date;
	  };

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;

// TODO: Remove this once we are more confident in the feature
// localStorage.setItem("betaUploadProgress", "true");
const enableBetaUploadProgress =
	"localStorage" in globalThis
		? localStorage.getItem("betaUploadProgress") === "true"
		: false;

export function useUploadProgress(videoId: Video.VideoId, enabledRaw: boolean) {
	const enabled = enableBetaUploadProgress ? enabledRaw : false;

	const query = useEffectQuery({
		queryKey: ["getUploadProgress", videoId],
		queryFn: () =>
			withRpc((rpc) => rpc.GetUploadProgress(videoId)).pipe(
				Effect.map((v) => Option.getOrNull(v ?? Option.none())),
			),
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
	if (!enabled || !query.data) return null;
	const lastUpdated = new Date(query.data.updatedAt);

	return (
		Date.now() - lastUpdated.getTime() > 5 * MINUTE
			? {
					status: "failed",
					lastUpdated,
				}
			: {
					status: "uploading",
					lastUpdated,
					progress:
						// `0/0` for progress is `NaN`
						query.data.total === 0
							? 0
							: (query.data.uploaded / query.data.total) * 100,
				}
	) satisfies UploadProgress;
}

const ProgressCircle = ({
	progress,
	className,
	progressTextClassName,
	subTextClassName,
}: {
	progress: number;
	className?: string;
	progressTextClassName?: string;
	subTextClassName?: string;
}) => {
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
					stroke="#3b82f6"
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
						"mt-0.5 leading-tight text-[10px] text-white/80",
						subTextClassName,
					)}
				>
					Uploading...
				</p>
			</div>
		</div>
	);
};

export default ProgressCircle;
