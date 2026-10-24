import clsx from "clsx";
import {
	Mic,
	MicOff,
	MoreVertical,
	PauseCircle,
	PlayCircle,
	RotateCcw,
	StopCircle,
} from "lucide-react";
import type { ComponentProps } from "react";
import { formatDuration } from "../../shared/format-duration";
import type { RecordingStatus, UploadSummary } from "../../shared/types";

const ActionButton = ({ className, ...props }: ComponentProps<"button">) => (
	<button
		{...props}
		type="button"
		className={clsx(
			"p-[0.25rem] rounded-lg transition-all",
			"text-gray-11",
			"h-8 w-8 flex items-center justify-center",
			"hover:bg-gray-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-9",
			"disabled:opacity-50 disabled:cursor-not-allowed",
			className,
		)}
	/>
);

const InlineChunkProgress = ({ upload }: { upload?: UploadSummary }) => {
	if (!upload || upload.totalChunks === 0) {
		return null;
	}

	const completedCount = upload.completedChunks;
	const failed = upload.failedChunks > 0;
	const progressRatio = Math.max(
		0,
		Math.min(
			1,
			upload.totalBytes > 0
				? upload.uploadedBytes / upload.totalBytes
				: completedCount / upload.totalChunks,
		),
	);
	const radius = 15.9155;
	const circumference = 2 * Math.PI * radius;
	const strokeDashoffset = circumference * (1 - progressRatio);
	const colorClass = failed
		? "text-[var(--red-11)]"
		: completedCount === upload.totalChunks
			? "text-[var(--green-11)]"
			: "text-blue-9";

	return (
		<div className="inline-flex items-center gap-2 rounded-lg px-1.5 py-1 text-[12px] text-gray-12">
			<div className="relative h-5 w-5" role="img" aria-label="Upload progress">
				<svg className="h-5 w-5 -rotate-90" viewBox="0 0 36 36">
					<title>Upload progress</title>
					<circle
						className="fill-none stroke-gray-4"
						strokeWidth={4}
						cx="18"
						cy="18"
						r={radius}
					/>
					<circle
						className={clsx(
							"fill-none stroke-current transition-[stroke-dashoffset] duration-300 ease-out",
							colorClass,
						)}
						strokeWidth={4}
						strokeLinecap="round"
						strokeDasharray={circumference}
						strokeDashoffset={strokeDashoffset}
						cx="18"
						cy="18"
						r={radius}
					/>
				</svg>
			</div>
			<span
				className={clsx(
					"font-semibold tabular-nums leading-none",
					failed ? "text-[var(--red-11)]" : "text-gray-12",
				)}
			>
				{completedCount}/{upload.totalChunks}
			</span>
		</div>
	);
};

type ActiveRecordingStatus = Extract<
	RecordingStatus,
	{ phase: "recording" | "paused" | "uploading" }
>;

interface RecordingBarProps {
	status: ActiveRecordingStatus;
	hasAudioTrack: boolean;
	disabled: boolean;
	onStop: () => void;
	onPauseResume: () => void;
}

export const RecordingBar = ({
	status,
	hasAudioTrack,
	disabled,
	onStop,
	onPauseResume,
}: RecordingBarProps) => {
	const isPaused = status.phase === "paused";
	const canStop = !disabled;
	const showTimer = status.phase === "recording" || isPaused;
	const statusText = showTimer
		? formatDuration(status.durationMs)
		: "Uploading";
	const canTogglePause = !disabled && status.phase !== "uploading";

	return (
		<div className="flex flex-row items-stretch rounded-[0.9rem] border border-gray-5 bg-gray-1 text-gray-12 shadow-[0_16px_60px_rgba(0,0,0,0.35)] w-full">
			<div className="flex flex-row justify-between flex-1 gap-3 p-[0.25rem]">
				<button
					type="button"
					onClick={onStop}
					disabled={!canStop}
					className="py-[0.25rem] px-[0.5rem] text-red-300 gap-[0.35rem] flex flex-row items-center rounded-lg transition-opacity disabled:opacity-60"
				>
					<StopCircle className="size-5" />
					<span className="font-[500] text-[0.875rem] tabular-nums">
						{statusText}
					</span>
				</button>

				<div className="flex gap-3 items-center">
					<InlineChunkProgress upload={status.upload} />
					<div className="flex relative justify-center items-center w-8 h-8">
						{hasAudioTrack ? (
							<>
								<Mic className="size-5 text-gray-12" />
								<div className="absolute bottom-1 left-1 right-1 h-0.5 bg-gray-10 overflow-hidden rounded-full">
									<div className="absolute inset-0 bg-blue-9" />
								</div>
							</>
						) : (
							<MicOff className="text-gray-7 size-5" />
						)}
					</div>

					<ActionButton
						onClick={onPauseResume}
						disabled={!canTogglePause}
						aria-label={isPaused ? "Resume recording" : "Pause recording"}
					>
						{isPaused ? (
							<PlayCircle className="size-5" />
						) : (
							<PauseCircle className="size-5" />
						)}
					</ActionButton>
					<ActionButton disabled aria-label="Restart recording">
						<RotateCcw className="size-5" />
					</ActionButton>
				</div>
			</div>
			<div
				className="flex items-center justify-center p-[0.25rem] border-l border-gray-5 text-gray-9"
				aria-hidden
			>
				<MoreVertical className="size-5" />
			</div>
		</div>
	);
};
