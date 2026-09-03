"use client";

import { classNames } from "@cap/utils/helpers";
import { useState } from "react";
import {
	CapCamera,
	CapChevronDown,
	CapFilmCut,
	CapInfo,
	CapInstant,
	CapLogoFull,
	CapMicrophone,
	CapScreenshot,
	LucideAppWindowMac,
	LucideBell,
	LucideCircleHelp,
	LucideImage,
	LucideMaximize2,
	LucideScanText,
	LucideSettings,
	LucideSquarePlay,
	LucideVideo,
	MdiMonitor,
	MsScreenshotFrame,
	PhMonitorBold,
} from "./capIcons";
import { TrafficLights, WindowsCaptionControls } from "./chrome";
import { useIsWindowsDemo } from "./platform";

/**
 * Pixel replica of the Cap desktop recorder window (compact 330×395 layout,
 * light theme) — markup and values mirror
 * apps/desktop/src/routes/(window-chrome)/new-main/index.tsx and friends.
 * In the interactive demo the controls are real buttons: the mode pills,
 * Display tile, and camera row report clicks up to the orchestrator, and
 * hover states (including the mode hovercards) come from the visitor's own
 * pointer.
 */

export type RecorderMode = "instant" | "studio";

export type RecorderUi = {
	visible: boolean;
	mode: RecorderMode;
	/** Display target selected (blue state on the Display tile). */
	displaySelected: boolean;
	/** Camera row populated + On pill. */
	cameraOn: boolean;
};

/* Desktop palette (Radix light values used by the app). */
const C = {
	gray1: "#fcfcfc",
	gray2: "#f9f9f9",
	gray3: "#f0f0f0",
	gray4: "#e8e8e8",
	gray5: "#e0e0e0",
	gray6: "#d9d9d9",
	gray7: "#cecece",
	gray8: "#bbbbbb",
	gray10: "#838383",
	gray11: "#646464",
	gray12: "#202020",
	blue3: "#e6f4fe",
	blue8: "#5eb1ef",
	blue9: "#0090ff",
	blue10: "#0588f0",
	blue11: "#0d74ce",
};

type HoverMode = RecorderMode | "screenshot";

const MODE_HOVERCARDS: Record<
	HoverMode,
	{ label: string; description: string }
> = {
	instant: {
		label: "Instant mode",
		description:
			"Uploads while you record and gives you a link to share when you stop.",
	},
	studio: {
		label: "Studio mode",
		description:
			"Saves recordings on your computer and opens the editor when you stop.",
	},
	screenshot: {
		label: "Screenshot mode",
		description:
			"Capture a window or area, adjust the background, and copy the image to your clipboard.",
	},
};

const HeaderIconButton = ({ children }: { children: React.ReactNode }) => (
	<span className="flex size-5 items-center justify-center text-[#646464]">
		{children}
	</span>
);

const InfoPill = ({ on }: { on: boolean }) => (
	<span
		className="inline-flex h-[24px] min-w-[40px] items-center justify-center rounded-full px-2.5 text-[11px] font-medium leading-none"
		style={
			on
				? { background: C.blue9, color: "#ffffff" }
				: { background: C.gray5, color: C.gray11 }
		}
	>
		{on ? "On" : "Off"}
	</span>
);

const DeviceRow = ({
	icon,
	label,
	on,
	showSettings,
	anchor,
	ariaLabel,
	onClick,
}: {
	icon: React.ReactNode;
	label: string;
	on: boolean;
	showSettings?: boolean;
	anchor?: string;
	ariaLabel: string;
	onClick: () => void;
}) => (
	<button
		type="button"
		data-demo-anchor={anchor}
		aria-label={ariaLabel}
		onClick={onClick}
		className="flex h-[42px] w-full cursor-pointer items-center gap-2.5 rounded-lg border border-[#d9d9d9] bg-[#f9f9f9] pl-3 pr-1.5 transition-colors duration-150 hover:border-[#bbbbbb] hover:bg-[#e8e8e8]"
	>
		<span className="size-4 shrink-0" style={{ color: C.gray11 }}>
			{icon}
		</span>
		<p
			className="min-w-0 flex-1 truncate text-left text-sm font-medium"
			style={{ color: C.gray12 }}
		>
			{label}
		</p>
		<span className="flex shrink-0 items-center gap-0.5">
			{showSettings ? (
				<span
					className="flex size-7 items-center justify-center rounded-md"
					style={{ color: C.gray10 }}
				>
					<LucideSettings className="size-3.5" />
				</span>
			) : null}
			<InfoPill on={on} />
		</span>
	</button>
);

const TargetTile = ({
	icon,
	name,
	selected,
	withDropdown,
	anchor,
	onClick,
}: {
	icon: React.ReactNode;
	name: string;
	selected?: boolean;
	withDropdown?: boolean;
	anchor?: string;
	onClick: () => void;
}) => (
	<button
		type="button"
		data-demo-anchor={anchor}
		aria-label={`Record ${name}`}
		onClick={onClick}
		className={classNames(
			"flex flex-1 cursor-pointer overflow-hidden rounded-lg border transition-[background-color,border-color] duration-150",
			selected
				? "border-[#5eb1ef] bg-[#e6f4fe] shadow-[0_0_0_1px_#fcfcfc,0_0_0_2px_#5eb1ef] hover:border-[#0090ff] hover:bg-[#d5efff]"
				: "border-[#d9d9d9] bg-[#f9f9f9] hover:border-[#bbbbbb] hover:bg-[#f0f0f0]",
		)}
	>
		<span
			className={classNames(
				"flex flex-1 flex-col items-center justify-end gap-1 py-2 text-center",
				withDropdown ? "pl-5" : "",
			)}
		>
			<span
				className="size-5 shrink-0"
				style={{ color: selected ? C.blue10 : C.gray10 }}
			>
				{icon}
			</span>
			<p className="text-xs" style={{ color: selected ? C.blue11 : C.gray12 }}>
				{name}
			</p>
		</span>
		{withDropdown ? (
			<span
				className="flex w-7 shrink-0 items-center justify-center border-l"
				style={{ background: C.gray4, borderColor: C.gray6 }}
			>
				<CapChevronDown className="size-4" style={{ color: C.gray11 }} />
			</span>
		) : null}
	</button>
);

const ModeButton = ({
	selected,
	hovered,
	anchor,
	label,
	onClick,
	onHover,
	children,
}: {
	selected: boolean;
	hovered: boolean;
	anchor: string;
	label: string;
	onClick: () => void;
	onHover: (over: boolean) => void;
	children: React.ReactNode;
}) => (
	<button
		type="button"
		data-demo-anchor={anchor}
		aria-label={label}
		aria-pressed={selected}
		onClick={onClick}
		onMouseEnter={() => onHover(true)}
		onMouseLeave={() => onHover(false)}
		className="relative flex size-7 cursor-pointer items-center justify-center rounded-full transition-all duration-200"
		style={{
			background: selected || hovered ? C.gray7 : C.gray3,
			boxShadow: selected
				? `0 0 0 1px ${C.gray1}, 0 0 0 3px #3b82f6`
				: undefined,
		}}
	>
		{children}
	</button>
);

export const CapRecorderWindow = ({
	ui,
	onMode,
	onSelectDisplay,
	onToggleCamera,
	onMiss,
}: {
	ui: RecorderUi;
	onMode: (mode: RecorderMode) => void;
	onSelectDisplay: () => void;
	onToggleCamera: () => void;
	onMiss: () => void;
}) => {
	const isWindows = useIsWindowsDemo();
	const [hoverMode, setHoverMode] = useState<HoverMode | null>(null);
	const hovercard = hoverMode ? MODE_HOVERCARDS[hoverMode] : null;

	const hover = (mode: HoverMode) => (over: boolean) =>
		setHoverMode((prev) => (over ? mode : prev === mode ? null : prev));

	return (
		<div
			inert={!ui.visible}
			className={classNames(
				"absolute select-none overflow-visible transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
				ui.visible
					? "opacity-100 [transform:scale(1)]"
					: "pointer-events-none opacity-0 [transform:scale(0.97)_translateY(6px)]",
			)}
			style={{ width: 330, height: 395, fontWeight: 500 }}
		>
			<div
				className="flex h-full w-full flex-col overflow-hidden rounded-[16px] backdrop-blur-[28px] backdrop-saturate-[1.45]"
				style={{
					background: "rgba(244,244,243,0.84)",
					border: "1px solid rgba(0,0,0,0.08)",
					boxShadow: "0 28px 80px rgba(0,0,0,0.26), 0 4px 18px rgba(0,0,0,0.1)",
				}}
			>
				{/* Titlebar */}
				<div
					className="flex h-9 w-full shrink-0 items-center border-b"
					style={{
						background: "rgba(250,250,249,0.72)",
						borderColor: "rgba(0,0,0,0.08)",
					}}
				>
					{/* macOS: close + zoom only, the way the recorder ships. Windows
					    puts its caption controls at the far end instead. */}
					{isWindows ? null : (
						<TrafficLights
							size={14}
							minimize={false}
							className="ml-3 gap-2.5"
						/>
					)}
					<div className="mx-2 flex min-w-0 flex-1 items-center gap-1">
						<HeaderIconButton>
							<LucideCircleHelp className="size-4" />
						</HeaderIconButton>
						<div className="min-h-9 min-w-0 flex-1" />
						<div className="flex shrink-0 items-center gap-1">
							<HeaderIconButton>
								<LucideMaximize2 className="size-3.5" />
							</HeaderIconButton>
							<HeaderIconButton>
								<LucideSettings className="size-4" />
							</HeaderIconButton>
							<HeaderIconButton>
								<LucideImage className="size-4" />
							</HeaderIconButton>
							<HeaderIconButton>
								<LucideSquarePlay className="size-4" />
							</HeaderIconButton>
							<HeaderIconButton>
								<LucideScanText className="size-4" />
							</HeaderIconButton>
							<HeaderIconButton>
								<LucideBell className="size-4" />
							</HeaderIconButton>
						</div>
					</div>
					{isWindows ? <WindowsCaptionControls className="h-9" /> : null}
				</div>

				{/* Body */}
				<div className="flex min-h-0 flex-1 flex-col gap-2 px-[13px] pb-[8px]">
					{/* Logo row + mode selector */}
					<div className="mb-[6px] mt-[16px] flex items-center justify-between">
						<div className="flex items-center space-x-1">
							<CapLogoFull className="h-auto w-[92px]" />
							<span
								className="ml-2 rounded-lg border px-1 py-0.5 text-[0.6rem] leading-normal"
								style={{
									borderColor: C.gray5,
									background: C.gray3,
									color: C.gray12,
								}}
							>
								Personal
							</span>
						</div>

						<div
							className="relative flex w-fit items-center gap-2 rounded-full border p-1.5"
							style={{ borderColor: C.gray5, background: C.gray3 }}
						>
							<span
								data-demo-anchor="mode-info"
								className="absolute -left-1.5 -top-2 flex rounded-full p-1"
								style={{ background: C.gray5 }}
							>
								<CapInfo className="size-2.5" style={{ color: "#000000" }} />
							</span>
							<ModeButton
								selected={ui.mode === "instant"}
								hovered={hoverMode === "instant"}
								anchor="mode-instant"
								label="Instant mode"
								onClick={() => onMode("instant")}
								onHover={hover("instant")}
							>
								<CapInstant className="h-4 w-auto" style={{ color: "#000" }} />
							</ModeButton>
							<ModeButton
								selected={ui.mode === "studio"}
								hovered={hoverMode === "studio"}
								anchor="mode-studio"
								label="Studio mode"
								onClick={() => onMode("studio")}
								onHover={hover("studio")}
							>
								<CapFilmCut
									className="h-[0.9rem] w-auto"
									style={{ color: "#000" }}
								/>
							</ModeButton>
							<ModeButton
								selected={false}
								hovered={hoverMode === "screenshot"}
								anchor="mode-screenshot"
								label="Screenshot mode"
								onClick={onMiss}
								onHover={hover("screenshot")}
							>
								<CapScreenshot
									className="size-[0.9rem]"
									style={{ color: "#000" }}
								/>
							</ModeButton>

							{/* Mode hovercard (bottom-end, gutter 12) */}
							<div
								className={classNames(
									"pointer-events-none absolute right-0 top-[calc(100%+12px)] z-20 transition-[opacity,transform] duration-150",
									hovercard
										? "translate-y-0 opacity-100"
										: "-translate-y-1 opacity-0",
								)}
							>
								<div
									className="flex min-w-[12rem] max-w-[15rem] flex-col gap-2 rounded-lg border px-3 py-2.5 shadow-lg"
									style={{
										background: C.gray12,
										borderColor: C.gray3,
										color: C.gray1,
									}}
								>
									<div className="flex flex-col gap-0.5">
										<span className="text-xs font-medium">
											{hovercard?.label ?? ""}
										</span>
										<span
											className="text-[10px] leading-snug"
											style={{ color: C.gray4 }}
										>
											{hovercard?.description ?? ""}
										</span>
									</div>
									<span
										className="-mx-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]"
										style={{ color: C.gray4 }}
									>
										<LucideSettings className="size-3" />
										<span>Quality settings</span>
									</span>
								</div>
							</div>
						</div>
					</div>

					{/* Capture targets */}
					<div className="flex w-full flex-col gap-2 text-xs">
						<div className="flex w-full flex-row items-stretch gap-2">
							<TargetTile
								icon={<MdiMonitor className="size-5" />}
								name="Display"
								selected={ui.displaySelected}
								withDropdown
								anchor="target-display"
								onClick={onSelectDisplay}
							/>
							<TargetTile
								icon={<LucideAppWindowMac className="size-5" />}
								name="Window"
								withDropdown
								onClick={onMiss}
							/>
						</div>
						<div className="flex w-full flex-row items-stretch gap-2">
							<TargetTile
								icon={<MsScreenshotFrame className="size-5" />}
								name="Area"
								onClick={onMiss}
							/>
							<TargetTile
								icon={<LucideVideo className="size-5" />}
								name="Camera Only"
								onClick={onMiss}
							/>
						</div>
					</div>

					{/* Device rows */}
					<div className="space-y-2">
						<DeviceRow
							icon={<CapCamera className="size-4" />}
							label={ui.cameraOn ? "MacBook Pro Camera" : "No Camera"}
							on={ui.cameraOn}
							showSettings={ui.cameraOn}
							anchor="row-camera"
							ariaLabel={ui.cameraOn ? "Turn camera off" : "Turn camera on"}
							onClick={onToggleCamera}
						/>
						<DeviceRow
							icon={<CapMicrophone className="size-4" />}
							label={isWindows ? "Microphone Array" : "MacBook Pro Microphone"}
							on
							showSettings
							anchor="row-mic"
							ariaLabel="Microphone"
							onClick={onMiss}
						/>
						<DeviceRow
							icon={<PhMonitorBold className="size-4" />}
							label="Record System Audio"
							on
							ariaLabel="System audio"
							onClick={onMiss}
						/>
					</div>
				</div>
			</div>
		</div>
	);
};
