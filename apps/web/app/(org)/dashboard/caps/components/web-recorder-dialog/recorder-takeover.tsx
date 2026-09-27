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
	mirror = true,
}: {
	stream: MediaStream | null;
	className?: string;
	mirror?: boolean;
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
			className={clsx(mirror && "-scale-x-100", className)}
		/>
	);
};

export const MicMeter = ({ level }: { level: number }) => (
	<span className="flex h-3 items-end gap-[2px]" aria-hidden>
		{[0.08, 0.2, 0.35, 0.5, 0.68].map((threshold) => (
			<span
				key={threshold}
				className={clsx(
					"w-[3px] rounded-full transition-colors duration-75",
					level > threshold ? "bg-[#3dd68c]" : "bg-white/20",
				)}
				style={{ height: `${Math.round(30 + threshold * 100)}%` }}
			/>
		))}
	</span>
);

export const TileLabel = ({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) => (
	<span
		className={clsx(
			"inline-flex h-7 items-center gap-1.5 rounded-full bg-black/55 px-2.5 text-[0.75rem] font-medium text-white backdrop-blur-md",
			className,
		)}
	>
		{children}
	</span>
);

export const LiveDot = ({ paused = false }: { paused?: boolean }) => (
	<span
		className={clsx(
			"size-1.5 rounded-full",
			paused
				? "bg-white/50"
				: "animate-pulse bg-[#ff4d4f] motion-reduce:animate-none",
		)}
	/>
);

type Track = {
	key: string;
	label: string;
	icon: LucideIcon;
	on: boolean;
};

// One chip per source. Each source becomes its own track in the editor, so
// the strip doubles as a promise of what the recording will contain.
export const TrackStrip = ({
	screen,
	camera,
	mic,
	systemAudio,
	live = false,
	paused = false,
}: {
	screen: boolean | null;
	camera: boolean;
	mic: boolean;
	systemAudio: boolean | null;
	live?: boolean;
	paused?: boolean;
}) => {
	const tracks: Track[] = [
		...(screen === null
			? []
			: [{ key: "screen", label: "Screen", icon: MonitorIcon, on: screen }]),
		{ key: "camera", label: "Camera", icon: CameraIcon, on: camera },
		{ key: "mic", label: "Mic", icon: MicIcon, on: mic },
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
	const count = tracks.filter((track) => track.on).length;

	return (
		<div className="flex flex-col items-center gap-2.5 text-center">
			<ul className="flex flex-wrap items-center justify-center gap-1.5">
				{tracks.map(({ key, label, icon: Icon, on }) => (
					<li
						key={key}
						className={clsx(
							"inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[0.8125rem] font-medium transition-colors duration-300",
							on
								? "border-white/10 bg-white/[0.07] text-white"
								: "border-dashed border-white/15 text-white/35",
						)}
					>
						<Icon className="size-3.5" aria-hidden />
						{label}
						{on && live && <LiveDot paused={paused} />}
					</li>
				))}
			</ul>
			<p className="text-[0.8125rem] text-white/50">
				{live
					? `Recording ${count} separate ${count === 1 ? "track" : "tracks"}. Change the layout in the editor after.`
					: count === 0
						? "Turn on what you want to record. Each source records as its own track."
						: `${count} separate ${count === 1 ? "track" : "tracks"}. Change the layout in the editor after you stop.`}
			</p>
		</div>
	);
};

export const PickingScreen = () => (
	<div className="flex flex-col items-center gap-5 text-center">
		<span className="flex size-14 items-center justify-center rounded-full bg-[#4785FF] text-white shadow-[0_0_0_10px_rgba(71,133,255,0.15)]">
			<ArrowUpIcon
				className="size-7 animate-bounce motion-reduce:animate-none"
				aria-hidden
			/>
		</span>
		<div className="flex max-w-md flex-col gap-2">
			<h2 className="text-balance text-2xl font-semibold tracking-tight text-white sm:text-3xl">
				Choose what to share
			</h2>
			<p className="text-balance text-[0.9375rem] leading-relaxed text-white/60">
				Pick a screen, window or tab in your browser's popup, then click Share.
			</p>
		</div>
	</div>
);

const formatMegabytes = (bytes: number) =>
	`${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;

const CAP_BLUE = "#4785FF";
// The uploader sends a part once this much has been recorded.
const PART_BYTES = 5 * 1024 * 1024;

// Parts travel from the recorder on the left to the share link on the right:
// the newest part sits next to the recorder, finished ones reach the link.
export const UploadStream = ({
	chunks,
	recordedBytes = 0,
	recording,
	paused = false,
}: {
	chunks: ChunkUploadState[];
	recordedBytes?: number;
	recording: boolean;
	paused?: boolean;
}) => {
	const bufferedBytes = Math.max(
		0,
		recordedBytes - chunks.reduce((total, chunk) => total + chunk.sizeBytes, 0),
	);
	const nextPartFill = Math.min(1, bufferedBytes / PART_BYTES);
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
				"flex w-full flex-col gap-2.5 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-3",
				paused && "upload-paused",
			)}
		>
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<span className="text-[0.8125rem] font-medium text-white/85">
					{recording
						? "Uploading while you record"
						: "Uploading the last parts"}
				</span>
				<span className="text-[0.75rem] tabular-nums text-white/45">
					{chunks.length === 0
						? recording
							? `Part 1 · ${formatMegabytes(bufferedBytes)} of ${formatMegabytes(PART_BYTES)}`
							: "Sending the recording"
						: `${done} of ${chunks.length} ${chunks.length === 1 ? "part" : "parts"} sent · ${formatMegabytes(sentBytes)}`}
				</span>
			</div>
			<div className="flex items-center gap-3">
				<div
					className={clsx(
						"relative flex h-11 w-9 shrink-0 items-end justify-center overflow-hidden rounded-lg border",
						recording
							? "border-[#ff4d4f]/40 bg-[#ff4d4f]/[0.06]"
							: "border-white/10 bg-white/[0.04]",
					)}
				>
					{recording ? (
						<>
							<span
								className="absolute inset-x-0 bottom-0 bg-[#ff4d4f]/30 transition-[height] duration-700 ease-out"
								style={{ height: `${Math.round(nextPartFill * 100)}%` }}
							/>
							<span className="relative mb-1 text-[0.5625rem] font-semibold tracking-wide text-[#ff7a7c]">
								REC
							</span>
						</>
					) : (
						<CheckIcon className="mb-3 size-3.5 text-white/50" aria-hidden />
					)}
				</div>
				<div className="relative flex h-11 min-w-0 flex-1 items-center justify-end overflow-hidden">
					<span className="upload-lane absolute inset-x-0 top-1/2 h-px -translate-y-1/2" />
					<ol className="relative flex shrink-0 items-center gap-1.5 pr-1">
						{visible.map((chunk) => (
							<li
								key={chunk.partNumber}
								className={clsx(
									"upload-tile relative flex h-10 w-7 shrink-0 items-end justify-center overflow-hidden rounded-md border transition-colors duration-300",
									chunk.status === "complete"
										? "border-transparent"
										: chunk.status === "error"
											? "border-[#ff4d4f] bg-[#ff4d4f]/15"
											: chunk.status === "uploading"
												? "border-[#4785FF]/70 bg-[#0c0c0e]"
												: "upload-queued border-dashed border-white/20 bg-[#0c0c0e]",
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
											backgroundColor: "rgba(71,133,255,0.4)",
										}}
									/>
								)}
								{chunk.status === "complete" ? (
									<CheckIcon
										className="upload-check absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 text-white"
										aria-hidden
									/>
								) : null}
								<span
									className={clsx(
										"relative mb-0.5 text-[0.5625rem] font-medium tabular-nums",
										chunk.status === "complete"
											? "text-white/75"
											: "text-white/45",
									)}
								>
									{chunk.partNumber}
								</span>
							</li>
						))}
					</ol>
				</div>
				<span
					key={done}
					className="upload-link flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[0.75rem] font-medium text-white"
					style={{ backgroundColor: CAP_BLUE }}
				>
					<LinkIcon className="size-3.5" aria-hidden />
					Your link
				</span>
			</div>
			<style>{`
				.upload-lane {
					background-image: linear-gradient(90deg, rgba(255,255,255,.22) 50%, transparent 0);
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
					30% { transform: scale(1.06); }
					100% { box-shadow: 0 0 0 12px rgba(71,133,255,0); transform: scale(1); }
				}
				.upload-paused .upload-lane { animation-play-state: paused; }
				@media (prefers-reduced-motion: reduce) {
					.upload-lane, .upload-tile, .upload-queued, .upload-check, .upload-link { animation: none; }
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
