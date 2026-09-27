"use client";

import type { ChunkUploadState } from "@cap/recorder-core/recorder-types";
import clsx from "clsx";
import {
	ArrowUpIcon,
	CameraIcon,
	CheckIcon,
	LinkIcon,
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

const formatMegabytes = (bytes: number) =>
	`${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;

const CAP_BLUE = "#4785FF";

// Parts travel from the recorder on the left to the share link on the right:
// the newest part sits next to the recorder, finished ones reach the link.
export const UploadStream = ({
	chunks,
	recording,
	paused = false,
}: {
	chunks: ChunkUploadState[];
	recording: boolean;
	paused?: boolean;
}) => {
	const done = chunks.filter((chunk) => chunk.status === "complete").length;
	const sentBytes = chunks.reduce(
		(total, chunk) =>
			total +
			(chunk.status === "complete" ? chunk.sizeBytes : chunk.uploadedBytes),
		0,
	);
	const visible = chunks.slice(-12).reverse();

	return (
		<section
			aria-label="Upload progress"
			className={clsx(
				"flex flex-col gap-4 rounded-2xl border border-gray-4 bg-gray-1 p-4 sm:p-5",
				paused && "upload-paused",
			)}
		>
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<span className="text-[0.9375rem] font-medium text-gray-12">
					{recording
						? "Uploading while you record"
						: "Uploading the last parts"}
				</span>
				<span className="text-[0.8125rem] tabular-nums text-gray-10">
					{chunks.length === 0
						? "First part uploads in a few seconds"
						: `${done} of ${chunks.length} parts sent · ${formatMegabytes(sentBytes)}`}
				</span>
			</div>
			<div className="flex items-center gap-3">
				<div
					className={clsx(
						"relative flex h-16 w-12 shrink-0 items-end justify-center overflow-hidden rounded-xl border",
						recording
							? "border-[#e5484d]/40 bg-[#e5484d]/5"
							: "border-gray-4 bg-gray-2",
					)}
				>
					{recording ? (
						<>
							<span className="upload-live-fill absolute inset-x-0 bottom-0 bg-[#e5484d]/20" />
							<span className="relative mb-1.5 flex items-center gap-1 text-[0.625rem] font-semibold text-[#e5484d]">
								<span className="size-1.5 animate-pulse rounded-full bg-[#e5484d] motion-reduce:animate-none" />
								REC
							</span>
						</>
					) : (
						<CheckIcon className="mb-4 size-4 text-gray-10" aria-hidden />
					)}
				</div>
				<div className="relative flex h-16 min-w-0 flex-1 items-center justify-end overflow-hidden">
					<span className="upload-lane absolute inset-x-0 top-1/2 h-px -translate-y-1/2" />
					<ol className="relative flex shrink-0 items-center gap-2 pr-1">
						{visible.map((chunk) => (
							<li
								key={chunk.partNumber}
								className={clsx(
									"upload-tile relative flex h-14 w-10 shrink-0 items-end justify-center overflow-hidden rounded-lg border transition-colors duration-300",
									chunk.status === "complete"
										? "border-transparent"
										: chunk.status === "error"
											? "border-red-9 bg-red-3"
											: chunk.status === "uploading"
												? "border-blue-7 bg-gray-1"
												: "upload-queued border-dashed border-gray-6 bg-gray-2",
								)}
								style={
									chunk.status === "complete"
										? { backgroundColor: CAP_BLUE }
										: undefined
								}
								title={`Part ${chunk.partNumber}`}
							>
								{chunk.status === "uploading" && (
									<span
										className="absolute inset-x-0 bottom-0 transition-[height] duration-300 ease-out"
										style={{
											height: `${Math.max(8, Math.round(chunk.progress * 100))}%`,
											backgroundColor: "rgba(71,133,255,0.35)",
										}}
									/>
								)}
								{chunk.status === "complete" ? (
									<CheckIcon
										className="upload-check absolute left-1/2 top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 text-white"
										aria-hidden
									/>
								) : null}
								<span
									className={clsx(
										"relative mb-1 text-[0.625rem] font-medium tabular-nums",
										chunk.status === "complete"
											? "text-white/80"
											: "text-gray-10",
									)}
								>
									{chunk.partNumber}
								</span>
							</li>
						))}
					</ol>
				</div>
				<div className="flex shrink-0 flex-col items-center gap-1">
					<span
						key={done}
						className="upload-link flex size-12 items-center justify-center rounded-full text-white"
						style={{ backgroundColor: CAP_BLUE }}
					>
						<LinkIcon className="size-5" aria-hidden />
					</span>
					<span className="text-[0.6875rem] font-medium text-gray-10">
						Your link
					</span>
				</div>
			</div>
			<style>{`
				.upload-lane {
					background-image: linear-gradient(90deg, var(--gray-6) 50%, transparent 0);
					background-size: 10px 1px;
					animation: upload-lane .7s linear infinite;
				}
				@keyframes upload-lane { to { background-position-x: 10px; } }
				.upload-tile { animation: upload-tile-in .5s cubic-bezier(.2,.8,.2,1) both; }
				@keyframes upload-tile-in {
					from { opacity: 0; transform: translateX(-18px) scale(.8); }
					to { opacity: 1; transform: none; }
				}
				.upload-queued { animation: upload-tile-in .5s cubic-bezier(.2,.8,.2,1) both, upload-wait 1.4s ease-in-out .5s infinite; }
				@keyframes upload-wait { 50% { opacity: .55; } }
				.upload-check { animation: upload-check .4s cubic-bezier(.2,1.4,.4,1) both; }
				@keyframes upload-check {
					from { opacity: 0; transform: translate(-50%, -50%) scale(.3); }
					to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
				}
				.upload-link { animation: upload-link .7s ease-out; }
				@keyframes upload-link {
					0% { box-shadow: 0 0 0 0 rgba(71,133,255,.55); transform: scale(1); }
					30% { transform: scale(1.08); }
					100% { box-shadow: 0 0 0 14px rgba(71,133,255,0); transform: scale(1); }
				}
				.upload-live-fill { animation: upload-live-fill 7s ease-in-out infinite; }
				@keyframes upload-live-fill { from { height: 0%; } to { height: 100%; } }
				.upload-paused .upload-lane, .upload-paused .upload-live-fill { animation-play-state: paused; }
				@media (prefers-reduced-motion: reduce) {
					.upload-lane, .upload-tile, .upload-queued, .upload-check, .upload-link, .upload-live-fill { animation: none; }
					.upload-live-fill { height: 50%; }
				}
			`}</style>
		</section>
	);
};

export const CountdownDial = ({ value }: { value: number }) => (
	<span className="relative flex size-44 items-center justify-center sm:size-56">
		<svg
			viewBox="0 0 100 100"
			className="absolute inset-0 size-full -rotate-90"
		>
			<title>Countdown</title>
			<circle
				cx="50"
				cy="50"
				r="46"
				fill="none"
				stroke="rgba(255,255,255,0.25)"
				strokeWidth="3"
			/>
			<circle
				key={value}
				cx="50"
				cy="50"
				r="46"
				fill="none"
				stroke="#fff"
				strokeWidth="3"
				strokeLinecap="round"
				strokeDasharray="289"
				className="countdown-ring"
			/>
		</svg>
		<span
			key={value}
			className="countdown-number text-[5.5rem] font-semibold tabular-nums leading-none text-white sm:text-[7rem]"
		>
			{value}
		</span>
		<style>{`
			.countdown-ring { animation: countdown-ring 1s linear both; }
			@keyframes countdown-ring { from { stroke-dashoffset: 0; } to { stroke-dashoffset: 289; } }
			.countdown-number { animation: countdown-number 1s cubic-bezier(.2,.8,.2,1) both; }
			@keyframes countdown-number {
				0% { opacity: 0; transform: scale(1.6); filter: blur(8px); }
				18% { opacity: 1; transform: scale(1); filter: blur(0); }
				82% { opacity: 1; transform: scale(.94); }
				100% { opacity: 0; transform: scale(.7); }
			}
			@media (prefers-reduced-motion: reduce) {
				.countdown-ring, .countdown-number { animation: none; }
			}
		`}</style>
	</span>
);
