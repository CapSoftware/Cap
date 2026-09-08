"use client";

import { classNames } from "@cap/utils/helpers";
import type { RefObject } from "react";
import type { RecorderMode } from "./CapRecorderWindow";
import {
	CapCamera,
	CapCaretDown,
	CapFilmCut,
	CapGear,
	CapInfo,
	CapInstant,
	CapLogoMark,
	CapMicrophone,
	CapMoreVertical,
	CapPauseCircle,
	CapPlay,
	CapRestart,
	CapSettingsGear,
	CapStopCircle,
	CapTrash,
	CapX,
} from "./capIcons";
import { useVideoAttrs, VIDEO_POSTERS } from "./media";
import { OS_FONT, useIsWindowsDemo } from "./platform";

const ToolButton = ({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
}) => (
	<button
		type="button"
		aria-label={label}
		onClick={onClick}
		className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg p-1 transition-colors duration-100 hover:bg-[#f0f0f0]"
		style={{ color: "#646464" }}
	>
		{children}
	</button>
);

export const RecordingToolbar = ({
	visible,
	paused,
	timerRef,
	onStop,
	onTogglePause,
	onRestart,
	onMiss,
}: {
	visible: boolean;
	paused: boolean;
	timerRef: RefObject<HTMLSpanElement | null>;
	onStop: () => void;
	onTogglePause: () => void;
	onRestart: () => void;
	onMiss: () => void;
}) => (
	<div
		inert={!visible}
		className={classNames(
			"absolute transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
			visible
				? "translate-y-0 opacity-100"
				: "pointer-events-none translate-y-3 opacity-0",
		)}
		style={{ width: 296, fontWeight: 500 }}
	>
		<div
			className="flex h-10 w-full flex-row items-stretch overflow-hidden rounded-2xl border"
			style={{
				background: "#fcfcfc",
				borderColor: "#e0e0e0",
				boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
			}}
		>
			<div className="flex flex-1 flex-row justify-between p-1">
				<button
					type="button"
					data-demo-anchor="toolbar-stop"
					aria-label="Stop recording"
					onClick={onStop}
					className="flex cursor-pointer flex-row items-center gap-1 rounded-lg px-2 py-1 transition-colors duration-100 hover:bg-[rgba(239,68,68,0.08)]"
					style={{ color: "#ff4766" }}
				>
					<CapStopCircle className="size-5" />
					<span
						ref={timerRef}
						className="text-[0.875rem] font-medium tabular-nums"
					>
						0:00
					</span>
				</button>

				<div
					data-demo-anchor="toolbar-tools"
					className="flex items-center gap-1"
				>
					<div className="relative flex h-8 w-8 items-center justify-center">
						<CapMicrophone className="size-5" style={{ color: "#202020" }} />
						<span
							className="absolute inset-x-1 bottom-1 h-0.5 overflow-hidden rounded-full"
							style={{ background: "#838383" }}
						>
							<span
								className={classNames(
									"absolute inset-0 rounded-full",
									paused ? "" : "ht-demo-mic-meter",
								)}
								style={{ background: "#0090ff" }}
							/>
						</span>
					</div>
					<ToolButton
						label={paused ? "Resume recording" : "Pause recording"}
						onClick={onTogglePause}
					>
						{paused ? (
							<CapPlay className="ml-0.5 h-3.5 w-auto" />
						) : (
							<CapPauseCircle className="size-5" />
						)}
					</ToolButton>
					<ToolButton label="Restart recording" onClick={onRestart}>
						<CapRestart className="size-5" />
					</ToolButton>
					<ToolButton label="Discard recording" onClick={onMiss}>
						<CapTrash className="size-5" />
					</ToolButton>
					<ToolButton label="Recording settings" onClick={onMiss}>
						<CapSettingsGear className="size-5" />
					</ToolButton>
				</div>
			</div>

			<div
				className="flex items-center border-l p-1"
				style={{ borderColor: "#e0e0e0" }}
			>
				<CapMoreVertical className="size-5" style={{ color: "#838383" }} />
			</div>
		</div>
	</div>
);

export const CameraWindow = ({
	visible,
	videoRef,
}: {
	visible: boolean;
	videoRef: RefObject<HTMLVideoElement | null>;
}) => {
	const videoAttrs = useVideoAttrs(VIDEO_POSTERS.webcam, visible);
	return (
		<div
			data-demo-anchor="camera-window"
			className={classNames(
				"absolute transition-[opacity,transform] duration-[400ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
				visible
					? "opacity-100 [transform:scale(1)]"
					: "pointer-events-none opacity-0 [transform:scale(0.6)]",
			)}
			style={{ width: 230, height: 230 }}
		>
			<div
				className="h-full w-full overflow-hidden rounded-full"
				style={{
					background: "#111111",
					boxShadow:
						"0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)",
				}}
			>
				<video
					ref={videoRef}
					className="h-full w-full object-cover"
					src="/videos/home-two/webcam.mp4"
					muted
					loop
					playsInline
					{...videoAttrs}
				/>
			</div>
		</div>
	);
};

const GLASS: React.CSSProperties = {
	background: "rgba(252,252,252,0.82)",
	border: "1px solid rgba(32,32,32,0.1)",
	boxShadow:
		"0 20px 25px -5px rgba(0,0,0,0.2), 0 8px 10px -6px rgba(0,0,0,0.2)",
};

const OverlayDeviceRow = ({
	icon,
	label,
	on,
}: {
	icon: React.ReactNode;
	label: string;
	on: boolean;
}) => (
	<div
		className="flex h-[42px] w-full flex-row items-center gap-2 rounded-lg border px-2"
		style={{ borderColor: "#e0e0e0", background: "#f0f0f0" }}
	>
		<span className="size-4 shrink-0" style={{ color: "#838383" }}>
			{icon}
		</span>
		<p
			className="min-w-0 flex-1 truncate text-left text-sm"
			style={{ color: "#202020" }}
		>
			{label}
		</p>
		<span
			className="inline-flex h-[24px] min-w-[40px] shrink-0 items-center justify-center rounded-full px-2.5 text-[11px] font-medium leading-none"
			style={
				on
					? { background: "#0090ff", color: "#fff" }
					: { background: "#e0e0e0", color: "#646464" }
			}
		>
			{on ? "On" : "Off"}
		</span>
	</div>
);

export const TargetOverlayPanel = ({
	visible,
	mode,
	cameraOn,
	onStart,
	onClose,
}: {
	visible: boolean;
	mode: RecorderMode;
	cameraOn: boolean;
	onStart: () => void;
	onClose: () => void;
}) => {
	const isWindows = useIsWindowsDemo();
	const modeLabel = mode === "instant" ? "Instant" : "Studio";
	return (
		<div
			inert={!visible}
			className={classNames(
				"absolute flex flex-col items-center transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
				visible
					? "translate-y-0 opacity-100"
					: "pointer-events-none translate-y-4 opacity-0",
			)}
			style={{ width: 416, fontWeight: 500 }}
		>
			<div className="my-2.5 flex w-full flex-col items-stretch gap-2.5">
				<div className="rounded-2xl p-3 backdrop-blur-xl" style={GLASS}>
					<div className="flex items-center gap-2.5">
						<button
							type="button"
							aria-label="Close target selection"
							onClick={onClose}
							className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full transition-transform duration-150 hover:scale-105"
							style={{ background: "#202020" }}
						>
							<CapX className="size-3" style={{ color: "#ffffff" }} />
						</button>

						<button
							type="button"
							data-demo-anchor="overlay-start"
							aria-label="Start recording"
							onClick={onStart}
							className="group flex h-11 min-w-0 max-w-[18rem] flex-1 cursor-pointer flex-row overflow-hidden rounded-full text-white"
							style={{
								background:
									"linear-gradient(to right, #0588f0 0%, #0588f0 55%, #0d74ce 100%)",
							}}
						>
							<span className="flex min-w-0 flex-1 items-center py-1 pl-4 transition-colors group-hover:bg-white/10">
								{mode === "instant" ? (
									<CapInstant className="h-4 w-auto shrink-0" />
								) : (
									<CapFilmCut className="h-4 w-auto shrink-0" />
								)}
								<span className="ml-3 mr-2 flex min-w-0 flex-col">
									<span className="whitespace-nowrap text-left text-[0.95rem] font-medium text-white">
										Start Recording
									</span>
									<span className="-mt-0.5 flex items-center gap-1 whitespace-nowrap text-[11px] font-light text-white/90">
										{modeLabel} Mode
									</span>
								</span>
							</span>
							<span
								className="flex items-center border-l py-1.5 pl-2.5 pr-3"
								style={{
									borderColor: "rgba(255,255,255,0.2)",
									background: "rgba(255,255,255,0.05)",
								}}
							>
								<CapCaretDown className="h-1.5 w-2.5" />
							</span>
						</button>

						<span
							className="flex size-9 shrink-0 items-center justify-center rounded-full border"
							style={{
								background: "#d9d9d9",
								borderColor: "rgba(0,0,0,0.08)",
								color: "#202020",
							}}
						>
							<CapGear className="size-5" />
						</span>
					</div>
				</div>

				<div className="rounded-2xl p-3 backdrop-blur-xl" style={GLASS}>
					<div className="grid w-full grid-cols-2 gap-2">
						<OverlayDeviceRow
							icon={<CapCamera className="size-4" />}
							label={
								cameraOn
									? isWindows
										? "Integrated Webcam"
										: "MacBook Pro Camera"
									: "No Camera"
							}
							on={cameraOn}
						/>
						<OverlayDeviceRow
							icon={<CapMicrophone className="size-4" />}
							label={isWindows ? "Microphone Array" : "MacBook Pro Microphone"}
							on
						/>
					</div>
				</div>
			</div>

			<div className="mt-1 flex w-fit items-center justify-center gap-1">
				<CapInfo className="size-3 opacity-70" style={{ color: "#ffffff" }} />
				<p className="text-sm text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.55)]">
					<span className="opacity-70">What is </span>
					<span className="font-medium">{modeLabel} Mode</span>?
				</p>
			</div>
		</div>
	);
};

export const LinkNotification = ({
	visible,
	onOpen,
}: {
	visible: boolean;
	onOpen: () => void;
}) => {
	const isWindows = useIsWindowsDemo();
	return (
		<div
			inert={!visible}
			data-demo-anchor="notification"
			className={classNames(
				"absolute transition-[opacity,transform] duration-[400ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
				visible
					? "translate-x-0 translate-y-0 opacity-100"
					: classNames(
							"pointer-events-none opacity-0",
							// The banner slides in from the right edge, the toast rises
							// off the taskbar, same as each OS does it.
							isWindows ? "translate-y-6" : "translate-x-6",
						),
			)}
			style={{ width: 344 }}
		>
			{isWindows ? (
				<button
					type="button"
					aria-label="Open the shared Cap"
					onClick={onOpen}
					className="flex w-full cursor-pointer flex-col gap-1.5 p-4 text-left transition-colors duration-200 hover:bg-[#fbfbfb]"
					style={{
						borderRadius: 8,
						background: "#f3f3f3",
						border: "1px solid rgba(0,0,0,0.07)",
						boxShadow: "0 16px 40px rgba(0,0,0,0.28)",
						fontFamily: OS_FONT.windows,
					}}
				>
					<span className="flex items-center gap-2">
						<CapLogoMark className="size-4 shrink-0" />
						<span className="text-[12px]" style={{ color: "#5c5c5c" }}>
							Cap
						</span>
						<span className="flex-1" />
						<span className="text-[12px]" style={{ color: "#5c5c5c" }}>
							now
						</span>
					</span>
					<span
						className="text-[14px] font-semibold"
						style={{ color: "#1b1b1b" }}
					>
						Link copied
					</span>
					<span className="text-[13px]" style={{ color: "#404040" }}>
						The share link is on your clipboard. Click to open it.
					</span>
				</button>
			) : (
				<button
					type="button"
					aria-label="Open the shared Cap"
					onClick={onOpen}
					className="flex w-full cursor-pointer items-center gap-3 rounded-2xl p-3 text-left backdrop-blur-xl transition-transform duration-200 hover:scale-[1.02]"
					style={{
						background: "rgba(245,245,245,0.78)",
						border: "1px solid rgba(0,0,0,0.06)",
						boxShadow:
							"0 12px 32px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.1)",
					}}
				>
					<CapLogoMark className="size-9 shrink-0" />
					<span className="min-w-0 flex-1 leading-tight">
						<p
							className="truncate text-[13px] font-semibold"
							style={{ color: "#1d1d1f" }}
						>
							Link Copied
						</p>
						<p className="truncate text-[13px]" style={{ color: "#48484a" }}>
							Link copied to clipboard
						</p>
					</span>
					<span className="self-start text-[11px]" style={{ color: "#86868b" }}>
						now
					</span>
				</button>
			)}
		</div>
	);
};
