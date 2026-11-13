import clsx from "clsx";
import {
	INFRA_VIDEO_DISPLAY_LABELS,
	type InfraVideoDisplayState,
} from "@/lib/infra-video-view";

export function VideoStatus({
	state,
	className,
}: {
	state: InfraVideoDisplayState;
	className?: string;
}) {
	const working = state === "processing" || state === "uploading";
	const unfinished = state === "unfinished";
	return (
		<span
			className={clsx(
				"inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] leading-none",
				state === "ready" && "text-[#E8ECF4]",
				state === "failed" && "text-[#F2A199]",
				(working || unfinished) && "text-[rgba(232,236,244,0.58)]",
				className,
			)}
		>
			<span
				aria-hidden="true"
				className={clsx(
					"size-[5px] rounded-full",
					state === "ready" &&
						"bg-white shadow-[0_0_6px_1px_rgba(214,228,255,0.8)]",
					state === "failed" && "bg-[#F2A199]",
					working &&
						"animate-pulse bg-[rgba(232,236,244,0.7)] motion-reduce:animate-none",
					unfinished && "shadow-[inset_0_0_0_1px_rgba(232,236,244,0.5)]",
				)}
			/>
			{INFRA_VIDEO_DISPLAY_LABELS[state]}
		</span>
	);
}
