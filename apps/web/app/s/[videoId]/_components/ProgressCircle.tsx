"use client";

import type { Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { useEffectQuery } from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";

type UploadProgress =
	| {
			status: "preparing";
	  }
	| {
			status: "uploading";
			progress: number;
	  }
	| {
			status: "failed";
	  };

const fiveMinutes = 5 * 60 * 1000;

export function useUploadProgress(videoId: Video.VideoId) {
	const query = useEffectQuery({
		queryKey: ["getUploadProgress", videoId],
		queryFn: () =>
			withRpc((rpc) => rpc.GetUploadProgress(videoId)).pipe(
				Effect.map((v) => Option.getOrNull(v ?? Option.none())),
			),
		refetchInterval: (query) => (query.state.data ? 1000 : false),
	});
	if (!query.data) return null;

	const hasUploadFailed =
		Date.now() - new Date(query.data.updatedAt).getTime() > fiveMinutes;

	const isPreparing = query.data.total === 0; // `0/0` for progress is `NaN`

	return (
		isPreparing
			? {
					status: "preparing",
				}
			: hasUploadFailed
				? {
						status: "failed",
					}
				: {
						status: "uploading",
						progress: (query.data.uploaded / query.data.total) * 100,
					}
	) satisfies UploadProgress;
}

const ProgressCircle = ({
	progress,
	isFailed = false,
}: {
	progress: number;
	isFailed?: boolean;
}) => {
	const displayProgress = isFailed ? 100 : progress;
	const strokeColor = isFailed ? "#ef4444" : "#3b82f6";

	return (
		<div className="relative scale-100 size-full sm:scale-110 md:scale-[1.3]">
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
					strokeDashoffset={`${2 * Math.PI * 45 * (1 - displayProgress / 100)}`}
					className="transition-all duration-300 ease-out"
				/>
			</svg>

			<div className="flex absolute inset-0 flex-col justify-center items-center p-2">
				<p className="text-sm font-semibold tabular-nums text-white xs:text-sm md:text-lg">
					{Math.round(displayProgress)}%
				</p>
				<p className="mt-0.5 text-[10px] text-white/80">Uploading...</p>
			</div>
		</div>
	);
};

export default ProgressCircle;
