"use client";

import * as Popover from "@radix-ui/react-popover";
import clsx from "clsx";
import {
	ChevronDownIcon,
	LoaderCircleIcon,
	MicIcon,
	MicOffIcon,
	MonitorIcon,
	Settings2Icon,
	Volume2Icon,
	VolumeXIcon,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { DeviceMenu } from "./recorder-dock";
import { type MicLevelBinding, Switch } from "./recorder-parts";
import type { RecordingQuality } from "./recording-quality";

const MUTED_INK = { stroke: "var(--rec-text-3)" } as CSSProperties;

const ScreenDoodle = () => (
	<svg
		viewBox="0 0 200 136"
		className="rec-screen-doodle h-auto w-[clamp(5.5rem,22cqw,10rem)] overflow-visible"
		aria-hidden="true"
	>
		<g className="rec-boil">
			<path
				className="rec-ink rec-draw"
				pathLength={1}
				style={MUTED_INK}
				d="M 28 12 L 172 12 C 178 12 182 16 182 22 L 182 98 C 182 104 178 108 172 108 L 28 108 C 22 108 18 104 18 98 L 18 22 C 18 16 22 12 28 12 Z M 84 108 L 78 126 M 116 108 L 122 126 M 64 126 L 136 126"
			/>
			<g className="rec-fade" style={{ "--d": "0.5s" } as CSSProperties}>
				<rect
					className="rec-march"
					x="42"
					y="30"
					width="116"
					height="60"
					rx="6"
					fill="none"
					stroke="var(--rec-accent)"
					strokeWidth="2.5"
					strokeLinecap="round"
				/>
				<path
					className="rec-ink is-accent rec-bob"
					style={{ strokeWidth: 2.5 }}
					d="M 140 66 L 140 90 L 146 84 L 151 95 L 155.5 93 L 150.5 82 L 158 82 Z"
				/>
			</g>
		</g>
	</svg>
);

const PersonDoodle = () => (
	<svg
		viewBox="0 0 80 72"
		className="rec-person-doodle h-auto w-[38%] shrink-0 overflow-visible"
		aria-hidden="true"
	>
		<g className="rec-boil">
			<path
				className="rec-ink rec-draw"
				pathLength={1}
				style={{ ...MUTED_INK, strokeWidth: 2.5 }}
				d="M 29 25 a 11 11 0 1 0 22 0 a 11 11 0 1 0 -22 0 M 15 66 C 17 51 28 43 40 43 C 52 43 63 51 65 66"
			/>
		</g>
	</svg>
);

/**
 * One frame of a capture that can see this page. Played live it would repeat
 * inside itself, so it stays still.
 */
export const StillFrame = ({
	stream,
	className,
}: {
	stream: MediaStream;
	className?: string;
}) => {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.srcObject = stream;
		const draw = () => {
			if (!video.videoWidth) return;
			const scale = Math.min(1, 1280 / video.videoWidth);
			canvas.width = Math.round(video.videoWidth * scale);
			canvas.height = Math.round(video.videoHeight * scale);
			canvas
				.getContext("2d")
				?.drawImage(video, 0, 0, canvas.width, canvas.height);
			video.srcObject = null;
		};
		video.addEventListener("loadeddata", draw, { once: true });
		void video.play().catch(() => {});
		return () => {
			video.removeEventListener("loadeddata", draw);
			video.pause();
			video.srcObject = null;
		};
	}, [stream]);

	return <canvas ref={canvasRef} className={className} />;
};

export const ScreenPlaceholder = ({
	supported,
	picking,
	disabled,
	onSelect,
	style,
}: {
	supported: boolean;
	picking: boolean;
	disabled: boolean;
	onSelect: () => void;
	style?: CSSProperties;
}) => (
	<div
		className="rec-fade absolute inset-0 flex flex-col items-center justify-center gap-[clamp(0.5rem,3.5cqh,1.25rem)] p-6 text-center"
		style={style}
	>
		<ScreenDoodle />
		<div className="flex max-w-[24rem] flex-col items-center gap-1">
			<h2 className="text-balance text-[clamp(15px,2.2cqw,18px)] font-medium tracking-[-0.01em]">
				{!supported
					? "This browser records your camera only"
					: picking
						? "Choose what to share in the popup"
						: "Select what to share"}
			</h2>
			<p className="rec-screen-hint text-balance text-[13px] leading-snug text-[var(--rec-text-2)]">
				{!supported
					? "Use Chrome or Edge on a computer to record your screen too."
					: picking
						? "Pick a screen, window or tab, then click Share."
						: "Your whole screen, one window or a browser tab."}
			</p>
		</div>
		{supported && (
			<button
				type="button"
				className="rec-btn is-accent !h-9 !px-4 !text-[14px]"
				disabled={disabled || picking}
				onClick={onSelect}
			>
				{picking ? (
					<LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
				) : (
					<MonitorIcon className="size-4" aria-hidden />
				)}
				Select screen
			</button>
		)}
	</div>
);

export const CameraPlaceholder = ({
	select,
	onDecline,
}: {
	select: ReactNode;
	onDecline: () => void;
}) => (
	<div className="rec-cam-placeholder flex size-full flex-col items-center justify-center gap-[6%] p-[9%] text-center">
		<PersonDoodle />
		{select}
		<button
			type="button"
			className="rec-cam-decline rec-focus rounded px-1 text-[12px] text-[var(--rec-text-2)] underline-offset-2 transition-colors hover:text-[var(--rec-text-1)] hover:underline"
			onClick={onDecline}
		>
			No camera
		</button>
	</div>
);

const CHIP =
	"rec-focus relative isolate flex h-9 min-w-0 items-center gap-2 overflow-hidden rounded-full bg-[var(--rec-ctl)] pl-3 pr-3 text-[13px] text-[var(--rec-text-1)] transition-colors hover:bg-[var(--rec-ctl-hover)] disabled:cursor-default disabled:hover:bg-[var(--rec-ctl)]";

export const MicChip = ({
	devices,
	selectedId,
	level,
	locked,
	requesting,
	onSelect,
	onRequestAccess,
}: {
	devices: MediaDeviceInfo[];
	selectedId: string | null;
	level: MicLevelBinding;
	locked: boolean;
	requesting: boolean;
	onSelect: (deviceId: string | null) => void;
	onRequestAccess: () => void;
}) => {
	if (devices.length === 0)
		return (
			<button
				type="button"
				className={CHIP}
				onClick={onRequestAccess}
				disabled={locked || requesting}
			>
				<MicOffIcon
					className="size-4 shrink-0 text-[var(--rec-text-2)]"
					aria-hidden
				/>
				<span className="truncate">Allow microphone</span>
			</button>
		);

	return (
		<DeviceMenu
			title="Microphone"
			devices={devices}
			selectedId={selectedId}
			fallbackName="Microphone"
			offLabel="No microphone"
			disabled={locked}
			onSelect={onSelect}
			className={clsx(
				CHIP,
				"max-w-[15rem] data-[state=open]:bg-[var(--rec-ctl-hover)]",
			)}
		>
			{(name) => (
				<>
					{selectedId && (
						<span
							ref={level}
							className="absolute inset-y-0 left-0 -z-10 w-[calc(var(--mic-level,0)*100%)] bg-[color-mix(in_srgb,var(--rec-level)_16%,transparent)]"
							aria-hidden
						/>
					)}
					{selectedId ? (
						<MicIcon className="size-4 shrink-0" aria-hidden />
					) : (
						<MicOffIcon
							className="size-4 shrink-0 text-[var(--rec-text-2)]"
							aria-hidden
						/>
					)}
					<span
						className={clsx(
							"truncate",
							!selectedId && "text-[var(--rec-text-2)]",
						)}
					>
						{selectedId ? name : "No microphone"}
					</span>
					{!locked && (
						<ChevronDownIcon
							className="-mr-1 size-3.5 shrink-0 text-[var(--rec-text-3)]"
							aria-hidden
						/>
					)}
				</>
			)}
		</DeviceMenu>
	);
};

export const SystemAudioChip = ({
	on,
	locked,
	onChange,
}: {
	on: boolean;
	locked: boolean;
	onChange: (next: boolean) => void;
}) => (
	<button
		type="button"
		role="switch"
		aria-checked={on}
		title="Record the sound playing on your computer, like a video or a call"
		className={CHIP}
		disabled={locked}
		onClick={() => onChange(!on)}
	>
		{on ? (
			<Volume2Icon className="size-4 shrink-0" aria-hidden />
		) : (
			<VolumeXIcon
				className="size-4 shrink-0 text-[var(--rec-text-2)]"
				aria-hidden
			/>
		)}
		<span className={clsx("truncate", !on && "text-[var(--rec-text-2)]")}>
			Computer sound
		</span>
		{!locked && <span className="rec-switch -mr-1 scale-[0.85]" data-on={on} />}
	</button>
);

const segmented = <T extends string | number>(
	value: T,
	options: readonly { value: T; label: string }[],
	onChange: (next: T) => void,
	name: string,
) => (
	<fieldset className="flex rounded-lg bg-[var(--rec-ctl)] p-0.5">
		<legend className="sr-only">{name}</legend>
		{options.map((option) => (
			<button
				key={String(option.value)}
				type="button"
				aria-pressed={value === option.value}
				onClick={() => onChange(option.value)}
				className={clsx(
					"rec-focus h-6 rounded-md px-2 text-[12px] font-medium transition-colors",
					value === option.value
						? "bg-[var(--rec-card)] text-[var(--rec-text-1)] shadow-[0_1px_2px_rgba(0,0,0,0.1),0_0_0_1px_var(--rec-line)]"
						: "text-[var(--rec-text-2)] hover:text-[var(--rec-text-1)]",
				)}
			>
				{option.label}
			</button>
		))}
	</fieldset>
);

const row = (label: string, control: ReactNode) => (
	<div
		key={label}
		className="flex min-h-9 items-center justify-between gap-3 px-2"
	>
		<span className="text-[13px] text-[var(--rec-text-2)]">{label}</span>
		{control}
	</div>
);

export const RecorderSettings = ({
	quality,
	onQualityChange,
	rememberDevices,
	onRememberDevicesChange,
}: {
	quality: RecordingQuality;
	onQualityChange: (update: Partial<RecordingQuality>) => void;
	rememberDevices: boolean;
	onRememberDevicesChange: (next: boolean) => void;
}) => (
	<Popover.Root modal={false}>
		<Popover.Trigger
			aria-label="Recording settings"
			title="Recording settings"
			className="rec-btn is-ghost is-icon !size-9 !rounded-full data-[state=open]:bg-[var(--rec-ctl)]"
		>
			<Settings2Icon className="size-4" aria-hidden />
		</Popover.Trigger>
		<Popover.Portal>
			<Popover.Content
				data-recorder-menu
				side="top"
				align="end"
				sideOffset={8}
				collisionPadding={12}
				className="cap-rec rec-pop z-[1000] flex w-[min(22rem,calc(100vw-24px))] flex-col p-2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
			>
				<span className="px-2 pb-1 pt-1 text-[13px] font-medium">
					Recording quality
				</span>
				{row(
					"Screen",
					segmented(
						quality.screenHeight,
						[
							{ value: 1080, label: "1080p" },
							{ value: 1440, label: "1440p" },
							{ value: 2160, label: "4K" },
						] as const,
						(screenHeight) => onQualityChange({ screenHeight }),
						"Screen resolution",
					),
				)}
				{row(
					"Frame rate",
					segmented(
						quality.frameRate,
						[
							{ value: 30, label: "30 fps" },
							{ value: 60, label: "60 fps" },
						] as const,
						(frameRate) => onQualityChange({ frameRate }),
						"Frame rate",
					),
				)}
				{row(
					"Camera",
					segmented(
						quality.cameraHeight,
						[
							{ value: 720, label: "720p" },
							{ value: 1080, label: "1080p" },
						] as const,
						(cameraHeight) => onQualityChange({ cameraHeight }),
						"Camera resolution",
					),
				)}
				{row(
					"Quality",
					segmented(
						quality.level,
						[
							{ value: "standard", label: "Standard" },
							{ value: "high", label: "High" },
						] as const,
						(level) => onQualityChange({ level }),
						"Video quality",
					),
				)}
				{(
					[
						["noiseSuppression", "Noise suppression"],
						["echoCancellation", "Echo cancellation"],
						["autoGainControl", "Auto gain"],
					] as const
				).map(([key, label]) =>
					row(
						label,
						<Switch
							label={label}
							on={quality.mic[key]}
							onChange={(next) =>
								onQualityChange({ mic: { ...quality.mic, [key]: next } })
							}
						/>,
					),
				)}
				<p className="px-2 pb-1 pt-1 text-[12px] leading-snug text-[var(--rec-text-3)]">
					Your video uploads while you record, so higher settings need a faster
					connection.
				</p>
				<div className="mt-1 border-t border-[var(--rec-line)] pt-1">
					{row(
						"Remember my camera and mic",
						<Switch
							label="Remember my camera and mic"
							on={rememberDevices}
							onChange={onRememberDevicesChange}
						/>,
					)}
				</div>
			</Popover.Content>
		</Popover.Portal>
	</Popover.Root>
);
