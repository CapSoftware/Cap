"use client";

import clsx from "clsx";
import {
	ArrowUpIcon,
	CameraIcon,
	CheckIcon,
	type LucideIcon,
	MicIcon,
	MonitorIcon,
	Volume2Icon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

export const formatClock = (ms: number) => {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

// Polls a stream getter so the page can show a stream another component owns
// (the camera preview or the recorder) without opening the device again.
export const useLiveStream = (
	getStream: () => MediaStream | null,
	enabled: boolean,
) => {
	const [stream, setStream] = useState<MediaStream | null>(null);

	useEffect(() => {
		if (!enabled) {
			setStream(null);
			return;
		}
		const sync = () => {
			const next = getStream();
			const live =
				next?.getVideoTracks().some((track) => track.readyState === "live") ??
				false;
			setStream((prev) => {
				const value = live ? next : null;
				return prev === value ? prev : value;
			});
		};
		sync();
		const interval = window.setInterval(sync, 300);
		return () => window.clearInterval(interval);
	}, [enabled, getStream]);

	return stream;
};

export const useMicLevel = (deviceId: string | null, enabled: boolean) => {
	const [level, setLevel] = useState(0);

	useEffect(() => {
		if (!enabled || !deviceId || typeof window === "undefined") {
			setLevel(0);
			return;
		}
		let disposed = false;
		let frame = 0;
		let stream: MediaStream | null = null;
		let context: AudioContext | null = null;

		void (async () => {
			try {
				stream = await navigator.mediaDevices.getUserMedia({
					audio: { deviceId: { exact: deviceId } },
				});
				if (disposed) {
					for (const track of stream.getTracks()) track.stop();
					return;
				}
				context = new AudioContext();
				const analyser = context.createAnalyser();
				analyser.fftSize = 512;
				context.createMediaStreamSource(stream).connect(analyser);
				const samples = new Float32Array(analyser.fftSize);
				let last = 0;
				const tick = (now: number) => {
					if (disposed) return;
					frame = requestAnimationFrame(tick);
					if (now - last < 60) return;
					last = now;
					analyser.getFloatTimeDomainData(samples);
					let sum = 0;
					for (const sample of samples) sum += sample * sample;
					const rms = Math.sqrt(sum / samples.length);
					setLevel(Math.min(1, rms * 4));
				};
				frame = requestAnimationFrame(tick);
			} catch {
				setLevel(0);
			}
		})();

		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			if (stream) for (const track of stream.getTracks()) track.stop();
			void context?.close().catch(() => {});
		};
	}, [deviceId, enabled]);

	return level;
};

export const LiveVideo = ({
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
		<video
			ref={videoRef}
			muted
			playsInline
			autoPlay
			className={clsx("-scale-x-100 object-cover", className)}
		/>
	);
};

export const MicMeter = ({ level }: { level: number }) => (
	<span className="flex h-3 items-end gap-[3px]" aria-hidden>
		{[0.08, 0.2, 0.35, 0.5, 0.68].map((threshold) => (
			<span
				key={threshold}
				className={clsx(
					"w-[3px] rounded-full transition-colors duration-75",
					level > threshold ? "bg-[#22B07D]" : "bg-gray-5",
				)}
				style={{ height: `${Math.round(30 + threshold * 100)}%` }}
			/>
		))}
	</span>
);

export const Overlay = ({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) => (
	<span
		className={clsx(
			"inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[0.75rem] font-medium text-white backdrop-blur-md",
			className,
		)}
	>
		{children}
	</span>
);

type Track = {
	key: string;
	label: string;
	icon: LucideIcon;
	on: boolean;
};

export const TrackList = ({
	screen,
	camera,
	mic,
	systemAudio,
	live = false,
}: {
	screen: boolean | null;
	camera: boolean;
	mic: boolean;
	systemAudio: boolean | null;
	live?: boolean;
}) => {
	const tracks: Track[] = [
		...(screen === null
			? []
			: [{ key: "screen", label: "Screen", icon: MonitorIcon, on: screen }]),
		{ key: "camera", label: "Camera", icon: CameraIcon, on: camera },
		{ key: "mic", label: "Microphone", icon: MicIcon, on: mic },
		...(systemAudio === null
			? []
			: [
					{
						key: "system",
						label: "System audio",
						icon: Volume2Icon,
						on: systemAudio,
					},
				]),
	];

	return (
		<ul className="flex flex-wrap gap-2">
			{tracks.map(({ key, label, icon: Icon, on }) => (
				<li
					key={key}
					className={clsx(
						"inline-flex items-center gap-2 rounded-full border py-1.5 pl-2.5 pr-3 text-[0.8125rem] font-medium",
						on
							? "border-gray-4 bg-gray-1 text-gray-12"
							: "border-dashed border-gray-4 text-gray-9",
					)}
				>
					<Icon className="size-4" aria-hidden />
					{label}
					{on ? (
						live ? (
							<span className="size-2 animate-pulse rounded-full bg-[#ff4d4d] motion-reduce:animate-none" />
						) : (
							<CheckIcon className="size-3.5 text-[#22B07D]" aria-hidden />
						)
					) : (
						<span className="text-[0.75rem] font-normal">off</span>
					)}
				</li>
			))}
		</ul>
	);
};

const STEPS = [
	{
		title: "Check your camera and mic",
		body: "Choose them on this page.",
	},
	{
		title: "Pick what to share",
		body: "Your browser asks for a screen, window or tab.",
	},
	{
		title: "Switch to it and present",
		body: "This tab keeps your controls. Come back to stop.",
	},
] as const;

export const Steps = ({ current }: { current: 0 | 1 | 2 }) => (
	<ol className="grid gap-3 sm:grid-cols-3">
		{STEPS.map((step, index) => {
			const done = index < current;
			const active = index === current;
			return (
				<li
					key={step.title}
					className={clsx(
						"flex items-start gap-3 rounded-xl border p-3.5 transition-colors",
						active ? "border-blue-7 bg-blue-2" : "border-gray-3 bg-gray-1",
					)}
				>
					<span
						className={clsx(
							"flex size-6 shrink-0 items-center justify-center rounded-full text-[0.75rem] font-semibold tabular-nums",
							active
								? "bg-blue-9 text-white"
								: done
									? "bg-gray-12 text-gray-1"
									: "bg-gray-3 text-gray-10",
						)}
					>
						{done ? <CheckIcon className="size-3.5" aria-hidden /> : index + 1}
					</span>
					<span className="flex min-w-0 flex-col gap-0.5">
						<span
							className={clsx(
								"text-[0.875rem] font-medium",
								active || done ? "text-gray-12" : "text-gray-10",
							)}
						>
							{step.title}
						</span>
						<span className="text-[0.8125rem] leading-snug text-gray-10">
							{step.body}
						</span>
					</span>
				</li>
			);
		})}
	</ol>
);

export const PickingScreen = () => (
	<div className="flex flex-col items-center gap-6 pt-2 text-center">
		<span className="flex size-14 items-center justify-center rounded-full bg-blue-9 text-white">
			<ArrowUpIcon
				className="size-7 animate-bounce motion-reduce:animate-none"
				aria-hidden
			/>
		</span>
		<div className="flex max-w-xl flex-col gap-2">
			<h2 className="text-balance text-3xl font-semibold tracking-tight text-gray-12 sm:text-4xl">
				Choose what to share
			</h2>
			<p className="text-balance text-base leading-relaxed text-gray-10 sm:text-lg">
				Your browser is asking which screen, window or tab to record. Pick one
				in the popup, then click Share.
			</p>
		</div>
	</div>
);
