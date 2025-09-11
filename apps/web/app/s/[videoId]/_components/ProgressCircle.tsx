"use client";

import { Effect, Option } from "effect";
import { useEffectQuery } from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";
import type { Video } from "@cap/web-domain";

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

const ProgressCircle = ({ progress }: { progress: number }) => {
	return (
		<div className="relative size-full">
			<svg className="transform -rotate-90 size-full" viewBox="0 0 100 100">
				<title>Progress Circle</title>
				{/* Background circle */}
				<circle
					cx="50"
					cy="50"
					r="45"
					fill="none"
					stroke="rgba(255, 255, 255, 0.2)"
					strokeWidth="5"
				/>
				{/* Progress circle */}
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
			{/* Progress text */}
			<div className="flex absolute inset-0 flex-col justify-center items-center">
				<span className="text-xs font-semibold tabular-nums text-white xs:text-sm md:text-lg">
					{Math.round(progress)}%
				</span>
				<span className="text-[11px] relative bottom-1.5 text-white opacity-75">
					Uploading Video...
				</span>
			</div>
		</div>
	);
};

export default ProgressCircle;
