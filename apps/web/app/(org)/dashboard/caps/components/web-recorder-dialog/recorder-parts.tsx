"use client";

import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import {
	type CSSProperties,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";

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

// Same curve as the desktop app's microphone row: a 40 dB window, eased so
// normal speech fills a good share of the row.
const DB_WINDOW = 40;
const levelFromRms = (rms: number) => {
	const db = 20 * Math.log10(Math.max(rms, 1e-6));
	const scaled = Math.min(1, Math.max(db + DB_WINDOW, 0) / DB_WINDOW);
	return 1 - (1 - scaled) ** 0.5;
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
					setLevel(levelFromRms(rms));
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

export type TrackKind = "screen" | "camera" | "mic" | "system";

// The hand-drawn wobble the extension's pages use, shared by every doodle.
export const BoilFilter = () => (
	<svg className="absolute size-0" aria-hidden="true">
		<defs>
			{/* biome-ignore lint/correctness/useUniqueElementIds: recorder.css filters every doodle through #rec-boil */}
			<filter id="rec-boil" x="-15%" y="-15%" width="130%" height="130%">
				<feTurbulence
					type="fractalNoise"
					baseFrequency="0.05"
					numOctaves="2"
					seed="1"
					result="noise"
				>
					<animate
						attributeName="seed"
						values="1;3;5;7"
						dur="0.6s"
						repeatCount="indefinite"
						calcMode="discrete"
					/>
				</feTurbulence>
				<feDisplacementMap
					in="SourceGraphic"
					in2="noise"
					scale="2.5"
					xChannelSelector="R"
					yChannelSelector="G"
				/>
			</filter>
		</defs>
	</svg>
);

const Sparks = ({ delay = 0.5 }: { delay?: number }) => (
	<>
		<path
			className="rec-spark"
			style={{ "--d": `${delay}s` } as CSSProperties}
			d="M 24 12 L 24 18 M 24 26 L 24 32 M 14 22 L 20 22 M 28 22 L 34 22"
		/>
		<path
			className="rec-spark"
			style={{ "--d": `${delay + 0.15}s` } as CSSProperties}
			d="M 98 4 L 98 10 M 98 18 L 98 24 M 88 14 L 94 14 M 102 14 L 108 14"
		/>
		<path
			className="rec-spark"
			style={{ "--d": `${delay + 0.3}s` } as CSSProperties}
			d="M 104 56 L 104 61 M 104 67 L 104 72 M 96 64 L 101 64 M 107 64 L 112 64"
		/>
	</>
);

export type DoodleKind = "upload" | "done" | "error" | "share" | "tracks";

export const Doodle = ({ kind }: { kind: DoodleKind }) => (
	<svg
		key={kind}
		viewBox="0 0 120 104"
		className="h-auto w-28 overflow-visible"
		aria-hidden="true"
	>
		<g className="rec-boil">
			{kind === "upload" && (
				<>
					<path
						className="rec-ink rec-draw"
						pathLength={1}
						d="M 34 58 L 88 58 C 98 58 106 50 106 41 C 106 32 98.5 25 89.5 25 C 86.5 25 84 25.7 81.8 27 C 79 16.5 69.5 9 58.5 9 C 47 9 37.5 16.8 34.8 27.5 C 25.2 28 17.5 35.4 17.5 44 C 17.5 52 24.8 58 34 58 Z"
					/>
					<g className="rec-fade" style={{ "--d": "0.7s" } as CSSProperties}>
						<path
							className="rec-ink is-accent rec-bob"
							d="M 60 92 L 60 68 M 49 78 L 60 66 L 71 78"
						/>
					</g>
				</>
			)}
			{kind === "done" && (
				<>
					<path
						className="rec-ink rec-draw"
						pathLength={1}
						style={{ "--d": "0.05s" } as CSSProperties}
						d="M 34 58 L 52 76 L 90 30"
					/>
					<Sparks />
				</>
			)}
			{kind === "error" && (
				<path
					className="rec-ink is-red rec-draw"
					pathLength={1}
					d="M 60 24 L 60 60 M 60 75 L 60 75.4"
				/>
			)}
			{kind === "tracks" && (
				<>
					{(
						[
							["var(--track-screen)", "M 18 30 L 102 30", 0],
							["var(--track-camera)", "M 18 52 L 84 52", 0.2],
							["var(--track-mic)", "M 18 74 L 94 74", 0.4],
						] as const
					).map(([color, d, delay]) => (
						<path
							key={d}
							className="rec-ink rec-draw"
							pathLength={1}
							d={d}
							style={
								{
									stroke: color,
									strokeWidth: 9,
									"--d": `${delay}s`,
								} as CSSProperties
							}
						/>
					))}
					<g className="rec-fade" style={{ "--d": "0.7s" } as CSSProperties}>
						<path
							className="rec-ink is-red"
							d="M 60 16 L 60 88"
							style={{ strokeWidth: 2.5 }}
						>
							<animateTransform
								attributeName="transform"
								type="translate"
								values="-36 0; 40 0; -36 0"
								dur="3.2s"
								repeatCount="indefinite"
								calcMode="spline"
								keySplines="0.45 0 0.55 1; 0.45 0 0.55 1"
							/>
						</path>
					</g>
				</>
			)}
			{kind === "share" && (
				<>
					<path
						className="rec-ink rec-draw"
						pathLength={1}
						d="M 22 26 L 98 26 C 101 26 103 28 103 31 L 103 75 C 103 78 101 80 98 80 L 22 80 C 19 80 17 78 17 75 L 17 31 C 17 28 19 26 22 26 Z M 48 96 L 72 96 M 60 80 L 60 96"
					/>
					<g className="rec-fade" style={{ "--d": "0.6s" } as CSSProperties}>
						<path
							className="rec-ink is-accent rec-bob"
							d="M 60 66 L 60 40 M 49 51 L 60 39 L 71 51"
						/>
					</g>
				</>
			)}
		</g>
	</svg>
);

const SQUIGGLE =
	"M 6 14 q 6 -7 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0";

// The extension's upload progress: a dotted squiggle the accent line fills.
// Without a fraction it marches while there is nothing to measure yet.
export const Squiggle = ({ progress }: { progress: number | null }) => (
	<div className="flex items-center gap-3.5">
		<svg
			viewBox="0 0 360 26"
			className="h-[26px] w-[min(320px,60vw)] overflow-visible"
			aria-hidden="true"
		>
			<path className="rec-squiggle-track" pathLength={100} d={SQUIGGLE} />
			<path
				className={clsx(
					"rec-squiggle-progress",
					progress === null && "is-waiting",
				)}
				pathLength={100}
				d={SQUIGGLE}
				style={
					progress === null
						? undefined
						: { strokeDashoffset: 100 - Math.round(progress * 100) }
				}
			/>
		</svg>
		<span
			className={clsx(
				"w-11 text-left text-[15px] font-medium tabular-nums transition-opacity",
				progress === null && "opacity-0",
			)}
		>
			{Math.round((progress ?? 0) * 100)}%
		</span>
	</div>
);

export const CountdownDial = ({ value }: { value: number }) => (
	<span className="relative flex size-44 items-center justify-center sm:size-52">
		<svg
			viewBox="0 0 120 120"
			className="absolute inset-0 size-full -rotate-90"
		>
			<title>Countdown</title>
			<circle
				cx="60"
				cy="60"
				r="54"
				fill="none"
				stroke="var(--rec-line-strong)"
				strokeWidth="3"
			/>
			<circle
				key={value}
				className="rec-countdown-ring"
				cx="60"
				cy="60"
				r="54"
			/>
		</svg>
		<span
			key={value}
			className="rec-countdown-number text-[88px] font-medium tabular-nums leading-none sm:text-[104px]"
		>
			{value}
		</span>
	</span>
);

// The desktop app's device row: the level fills the row from the left with a
// soft tint and a 2px line along the bottom.
export const LevelFill = ({ level }: { level: number }) => (
	<>
		<span
			className="pointer-events-none absolute inset-y-0 left-0 bg-[color-mix(in_srgb,var(--rec-level)_12%,transparent)] transition-[width] duration-100"
			style={{ width: `${level * 100}%` }}
			aria-hidden
		/>
		<span
			className="pointer-events-none absolute bottom-0 left-0 h-[2px] bg-[var(--rec-level)] transition-[width] duration-100"
			style={{ width: `${level * 100}%` }}
			aria-hidden
		/>
	</>
);

export const LevelRow = ({
	kind,
	icon: Icon,
	label,
	on,
	level,
	trailing,
}: {
	kind: TrackKind;
	icon: LucideIcon;
	label: string;
	on: boolean;
	level?: number;
	trailing?: ReactNode;
}) => (
	<div
		className="rec-track relative flex h-10 min-w-0 items-center gap-2.5 overflow-hidden rounded-lg bg-[var(--rec-ctl)] px-3"
		data-kind={kind}
		data-on={on}
	>
		{on && level !== undefined && <LevelFill level={level} />}
		<Icon
			className={clsx(
				"relative size-4 shrink-0",
				on ? "text-[var(--rec-text-1)]" : "text-[var(--rec-text-3)]",
			)}
			aria-hidden
		/>
		<span
			className={clsx(
				"relative min-w-0 flex-1 truncate text-[13px]",
				on ? "text-[var(--rec-text-1)]" : "text-[var(--rec-text-2)]",
			)}
		>
			{label}
		</span>
		{trailing && (
			<span className="relative flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--rec-text-3)]">
				{trailing}
			</span>
		)}
	</div>
);

export const SourceRow = ({
	kind,
	icon: Icon,
	label,
	on,
	detail,
	actions,
	level,
}: {
	kind: TrackKind;
	icon: LucideIcon;
	label: string;
	on: boolean;
	detail: ReactNode;
	actions: ReactNode;
	level?: number;
}) => (
	<li
		className="rec-track relative isolate flex items-center gap-2.5 overflow-hidden rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--rec-ctl)]"
		data-kind={kind}
		data-on={on}
	>
		{on && level !== undefined && (
			<span className="absolute inset-0 -z-10">
				<LevelFill level={level} />
			</span>
		)}
		<span className="rec-track-tile flex size-7 shrink-0 items-center justify-center rounded-md transition-colors">
			<Icon className="size-3.5" aria-hidden />
		</span>
		<span className="flex min-w-0 flex-1 flex-col">
			<span
				className={clsx(
					"truncate text-[13px] font-medium leading-5",
					on ? "text-[var(--rec-text-1)]" : "text-[var(--rec-text-2)]",
				)}
			>
				{label}
			</span>
			<span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-5 text-[var(--rec-text-2)]">
				{detail}
			</span>
		</span>
		<span className="flex shrink-0 items-center gap-0.5">{actions}</span>
	</li>
);

export const Switch = ({
	on,
	label,
	disabled,
	onChange,
}: {
	on: boolean;
	label: string;
	disabled?: boolean;
	onChange: (next: boolean) => void;
}) => (
	<button
		type="button"
		role="switch"
		aria-checked={on}
		aria-label={label}
		disabled={disabled}
		onClick={() => onChange(!on)}
		className="rec-focus flex h-8 w-10 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-45"
	>
		<span className="rec-switch" data-on={on} />
	</button>
);
