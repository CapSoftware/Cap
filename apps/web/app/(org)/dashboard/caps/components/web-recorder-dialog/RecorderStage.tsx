"use client";

import clsx from "clsx";
import {
	CameraIcon,
	CameraOffIcon,
	type LucideIcon,
	MicIcon,
	MonitorIcon,
	Volume2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	RECORDING_MODE_OPTIONS,
	type RecordingMode,
} from "./RecordingModeSelector";

export const TRACK_COLORS = {
	screen: "#4785FF",
	camera: "#9B6BFF",
	mic: "#22B07D",
	systemAudio: "#E8993A",
} as const;

type TrackKey = keyof typeof TRACK_COLORS;

interface RecorderStageProps {
	mode: RecordingMode;
	cameraEnabled: boolean;
	micEnabled: boolean;
	systemAudioEnabled: boolean;
	// Off while capturing: a live camera in this dialog would also land in a
	// full-screen capture and appear twice in the recording.
	showLiveCamera: boolean;
	getCameraStream: () => MediaStream | null;
}

// Mirrors the floating camera preview's stream so the stage shows the real
// camera without opening the device a second time.
const useMirroredStream = (
	enabled: boolean,
	getCameraStream: () => MediaStream | null,
) => {
	const [stream, setStream] = useState<MediaStream | null>(null);

	useEffect(() => {
		if (!enabled) {
			setStream(null);
			return;
		}
		const sync = () => {
			const next = getCameraStream();
			const live =
				next?.getVideoTracks().some((track) => track.readyState === "live") ??
				false;
			setStream((prev) => {
				const value = live ? next : null;
				return prev === value ? prev : value;
			});
		};
		sync();
		const interval = window.setInterval(sync, 400);
		return () => window.clearInterval(interval);
	}, [enabled, getCameraStream]);

	return stream;
};

const CameraFeed = ({
	stream,
	className,
}: {
	stream: MediaStream | null;
	className?: string;
}) => {
	const videoRef = useRef<HTMLVideoElement>(null);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		if (video.srcObject !== stream) video.srcObject = stream;
		if (stream) void video.play().catch(() => {});
	}, [stream]);

	return (
		<div className={clsx("overflow-hidden bg-gray-12/90", className)}>
			{stream ? (
				<video
					ref={videoRef}
					muted
					playsInline
					autoPlay
					className="size-full -scale-x-100 object-cover"
				/>
			) : (
				<div className="flex size-full items-center justify-center">
					<CameraIcon className="size-5 text-gray-1/60" aria-hidden />
				</div>
			)}
		</div>
	);
};

const SurfaceSketch = ({ mode }: { mode: RecordingMode }) => {
	if (mode === "tab") {
		return (
			<div className="absolute inset-[9%] flex flex-col overflow-hidden rounded-lg bg-gray-1 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.35)] ring-1 ring-gray-4">
				<div className="flex h-[18%] items-end gap-1 bg-gray-3 px-2">
					<div className="h-[70%] w-[28%] rounded-t-md bg-gray-1" />
					<div className="mb-1 h-[40%] w-[18%] rounded bg-gray-5/70" />
				</div>
				<div className="flex flex-1 flex-col gap-[7%] p-[5%]">
					<div className="h-[12%] w-[46%] rounded bg-gray-5" />
					<div className="h-[8%] w-[72%] rounded bg-gray-4" />
					<div className="h-[8%] w-[60%] rounded bg-gray-4" />
					<div className="mt-auto h-[26%] w-full rounded-md bg-blue-3" />
				</div>
			</div>
		);
	}

	if (mode === "window") {
		return (
			<div className="absolute inset-x-[14%] inset-y-[12%] flex flex-col overflow-hidden rounded-lg bg-gray-1 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.35)] ring-1 ring-gray-4">
				<div className="flex h-[14%] items-center gap-1 bg-gray-3 px-2">
					<span className="size-1.5 rounded-full bg-gray-6" />
					<span className="size-1.5 rounded-full bg-gray-6" />
					<span className="size-1.5 rounded-full bg-gray-6" />
				</div>
				<div className="grid flex-1 grid-cols-[30%_1fr] gap-[5%] p-[5%]">
					<div className="flex flex-col gap-[12%]">
						<div className="h-[10%] rounded bg-gray-4" />
						<div className="h-[10%] rounded bg-gray-4" />
						<div className="h-[10%] rounded bg-gray-4" />
					</div>
					<div className="rounded-md bg-blue-3" />
				</div>
			</div>
		);
	}

	return (
		<div className="absolute inset-0">
			<div className="absolute inset-x-0 top-0 h-[7%] bg-gray-1/70" />
			<div className="absolute left-[8%] top-[16%] h-[58%] w-[52%] overflow-hidden rounded-md bg-gray-1 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.35)] ring-1 ring-gray-4">
				<div className="h-[14%] bg-gray-3" />
				<div className="m-[6%] h-[50%] rounded bg-blue-3" />
			</div>
			<div className="absolute left-[46%] top-[34%] h-[46%] w-[38%] overflow-hidden rounded-md bg-gray-1 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.35)] ring-1 ring-gray-4">
				<div className="h-[16%] bg-gray-3" />
				<div className="m-[7%] flex flex-col gap-[10%]">
					<div className="h-2 w-[70%] rounded bg-gray-4" />
					<div className="h-2 w-[50%] rounded bg-gray-4" />
				</div>
			</div>
		</div>
	);
};

const StageLabel = ({
	icon: Icon,
	color,
	children,
	className,
}: {
	icon: LucideIcon;
	color: string;
	children: string;
	className?: string;
}) => (
	<span
		className={clsx(
			"inline-flex items-center gap-1 rounded-full bg-gray-12/75 py-0.5 pl-1.5 pr-2 text-[0.6875rem] font-medium text-gray-1 backdrop-blur-sm",
			className,
		)}
	>
		<Icon className="size-3" style={{ color }} aria-hidden />
		{children}
	</span>
);

const WAVE = [
	0.35, 0.6, 0.45, 0.8, 0.55, 0.3, 0.7, 0.9, 0.5, 0.35, 0.65, 0.4, 0.75, 0.55,
	0.3, 0.6, 0.85, 0.45, 0.35, 0.7, 0.5, 0.4, 0.65, 0.3,
];

const TrackLane = ({
	track,
	icon: Icon,
	label,
	enabled,
	kind,
}: {
	track: TrackKey;
	icon: LucideIcon;
	label: string;
	enabled: boolean;
	kind: "video" | "audio";
}) => {
	const color = TRACK_COLORS[track];
	return (
		<div
			className={clsx(
				"grid grid-cols-[6.5rem_1fr] items-center gap-2 transition-opacity duration-200",
				!enabled && "opacity-45",
			)}
		>
			<span className="flex min-w-0 items-center gap-1.5 text-[0.75rem] font-medium text-gray-12">
				<Icon
					className="size-3.5 shrink-0"
					style={{ color: enabled ? color : undefined }}
					aria-hidden
				/>
				<span className="truncate">{label}</span>
			</span>
			<div className="relative h-4 overflow-hidden rounded-[5px] bg-gray-3">
				{enabled ? (
					kind === "video" ? (
						<div
							className="absolute inset-y-0 left-0 right-[6%] rounded-[5px] border"
							style={{
								backgroundColor: `${color}2e`,
								borderColor: `${color}8c`,
							}}
						/>
					) : (
						<div className="absolute inset-y-0 left-0 right-[6%] flex items-center gap-[2px] px-1">
							{WAVE.map((height, index) => (
								<span
									key={`${track}-${index.toString()}`}
									className="flex-1 rounded-full"
									style={{
										height: `${Math.round(height * 100)}%`,
										backgroundColor: color,
										opacity: 0.75,
									}}
								/>
							))}
						</div>
					)
				) : (
					<span className="absolute inset-0 flex items-center pl-2 text-[0.625rem] font-medium text-gray-10">
						Off
					</span>
				)}
			</div>
		</div>
	);
};

export const RecorderStage = ({
	mode,
	cameraEnabled,
	micEnabled,
	systemAudioEnabled,
	showLiveCamera,
	getCameraStream,
}: RecorderStageProps) => {
	const stream = useMirroredStream(
		cameraEnabled && showLiveCamera,
		getCameraStream,
	);
	const cameraOnly = mode === "camera";
	const screenOption = RECORDING_MODE_OPTIONS[mode];

	return (
		<div className="flex flex-col gap-3">
			<div className="relative aspect-video w-full max-w-full overflow-hidden rounded-2xl bg-gradient-to-br from-gray-3 via-gray-2 to-gray-4 ring-1 ring-gray-4">
				{cameraOnly ? (
					cameraEnabled ? (
						<CameraFeed stream={stream} className="absolute inset-0" />
					) : (
						<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-10">
							<CameraOffIcon className="size-6" aria-hidden />
							<span className="text-xs">Choose a camera below</span>
						</div>
					)
				) : (
					<SurfaceSketch mode={mode} />
				)}
				{!cameraOnly && cameraEnabled && (
					<CameraFeed
						stream={stream}
						className="absolute bottom-[7%] right-[5%] aspect-square w-[24%] rounded-full shadow-[0_6px_20px_-6px_rgba(0,0,0,0.5)] ring-2 ring-[#9B6BFF]"
					/>
				)}
				<div className="absolute left-2.5 top-2.5 flex gap-1.5">
					{cameraOnly ? (
						<StageLabel icon={CameraIcon} color={TRACK_COLORS.camera}>
							Camera
						</StageLabel>
					) : (
						<StageLabel icon={screenOption.icon} color={TRACK_COLORS.screen}>
							{screenOption.label}
						</StageLabel>
					)}
				</div>
				{!cameraOnly && cameraEnabled && (
					<StageLabel
						icon={CameraIcon}
						color={TRACK_COLORS.camera}
						className="absolute bottom-[7%] right-[31%]"
					>
						Camera
					</StageLabel>
				)}
			</div>
			<div className="flex flex-col gap-1.5 rounded-xl border border-gray-4 bg-gray-1 p-2.5">
				<div className="relative flex flex-col gap-1.5">
					{!cameraOnly && (
						<TrackLane
							track="screen"
							icon={MonitorIcon}
							label="Screen"
							enabled
							kind="video"
						/>
					)}
					<TrackLane
						track="camera"
						icon={CameraIcon}
						label="Camera"
						enabled={cameraEnabled}
						kind="video"
					/>
					<TrackLane
						track="mic"
						icon={MicIcon}
						label="Microphone"
						enabled={micEnabled}
						kind="audio"
					/>
					{!cameraOnly && (
						<TrackLane
							track="systemAudio"
							icon={Volume2Icon}
							label="System audio"
							enabled={systemAudioEnabled}
							kind="audio"
						/>
					)}
					<div
						aria-hidden
						className="pointer-events-none absolute -inset-y-0.5 left-[7rem] right-0 motion-reduce:hidden"
					>
						<span className="recorder-playhead absolute inset-y-0 w-0.5 rounded-full bg-gray-12" />
					</div>
				</div>
				<p className="pt-1 text-[0.75rem] leading-snug text-gray-10">
					Each one is saved as its own track, so you can move, trim or remove
					them separately in the editor.
				</p>
			</div>
			<style>{`
				@keyframes recorder-playhead {
					0% { left: 0%; opacity: 0; }
					6% { opacity: 1; }
					88% { left: 94%; opacity: 1; }
					100% { left: 94%; opacity: 0; }
				}
				.recorder-playhead { animation: recorder-playhead 5s linear infinite; }
			`}</style>
		</div>
	);
};
