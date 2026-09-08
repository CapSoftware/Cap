"use client";

import { classNames } from "@cap/utils/helpers";
import { CapLogoMark } from "./capIcons";
import { OsSwitchButton } from "./chrome";
import { CapFileIcon, ImageFileIcon } from "./MacDesktop";
import { OS_FONT } from "./platform";

const WIN_FONT = OS_FONT.windows;

const StartGlyph = () => (
	<svg aria-hidden="true" viewBox="0 0 24 24" className="size-[19px]">
		{[
			[2, 2],
			[13, 2],
			[2, 13],
			[13, 13],
		].map(([x, y]) => (
			<rect
				key={`${x}-${y}`}
				x={x}
				y={y}
				width="9"
				height="9"
				rx="0.8"
				fill="#0078D4"
			/>
		))}
	</svg>
);

const SearchGlyph = () => (
	<svg aria-hidden="true" viewBox="0 0 24 24" className="size-[19px]">
		<circle
			cx="10.5"
			cy="10.5"
			r="6.5"
			fill="none"
			stroke="#1b1b1b"
			strokeWidth="1.7"
		/>
		<path
			d="m15.5 15.5 4.5 4.5"
			stroke="#1b1b1b"
			strokeWidth="1.7"
			strokeLinecap="round"
		/>
	</svg>
);

const ExplorerGlyph = () => (
	<svg aria-hidden="true" viewBox="0 0 24 24" className="size-[21px]">
		<path
			d="M2 6.4a1.6 1.6 0 0 1 1.6-1.6h5.1c.42 0 .82.17 1.13.46L11.4 6.6H20a1.6 1.6 0 0 1 1.6 1.6v.9H2Z"
			fill="#F2B33D"
		/>
		<path
			d="M2 8.6h19.6a1.6 1.6 0 0 1 1.58 1.87l-1.4 8A1.6 1.6 0 0 1 20.2 19.8H4.5a1.6 1.6 0 0 1-1.58-1.33l-1.4-8A1.6 1.6 0 0 1 2 8.6Z"
			fill="#FFCC5F"
		/>
	</svg>
);

const EdgeGlyph = () => (
	<svg aria-hidden="true" viewBox="0 0 24 24" className="size-[21px]">
		<circle cx="12" cy="12" r="10" fill="url(#ht-edge)" />
		<path
			d="M4.6 15.6c2.2 2.4 6 3.2 9.2 2 2-.8 3.3-2.2 3.3-3.6 0-1.3-1-2.2-2.8-2.2H9.4c-2.6 0-4.4-1.4-4.8-3.4a9.9 9.9 0 0 0 0 7.2Z"
			fill="#ffffff"
			fillOpacity="0.92"
		/>
		<defs>
			{/* biome-ignore lint/correctness/useUniqueElementIds: single-instance decorative svg defs */}
			<linearGradient id="ht-edge" x1="3" y1="4" x2="21" y2="20">
				<stop stopColor="#37C7F3" />
				<stop offset="0.55" stopColor="#1B84D6" />
				<stop offset="1" stopColor="#0C5BA8" />
			</linearGradient>
		</defs>
	</svg>
);

const TrayChevron = () => (
	<svg aria-hidden="true" viewBox="0 0 16 16" className="size-3">
		<path
			d="m4 10 4-4 4 4"
			fill="none"
			stroke="#1b1b1b"
			strokeWidth="1.4"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

const TrayWifi = () => (
	<svg aria-hidden="true" viewBox="0 0 16 12" className="h-[13px] w-auto">
		<path
			d="M8 10.9 0.9 3.9A10.1 10.1 0 0 1 8 1c2.7 0 5.2 1.05 7.1 2.9Z"
			fill="#1b1b1b"
		/>
	</svg>
);

const TraySpeaker = () => (
	<svg aria-hidden="true" viewBox="0 0 20 16" className="h-[13px] w-auto">
		<path d="M3 6h3l4-3.4v10.8L6 10H3Z" fill="#1b1b1b" />
		<path
			d="M12.6 5.2a3.8 3.8 0 0 1 0 5.6M14.9 3a7 7 0 0 1 0 10"
			fill="none"
			stroke="#1b1b1b"
			strokeWidth="1.3"
			strokeLinecap="round"
		/>
	</svg>
);

const TrayBattery = () => (
	<svg aria-hidden="true" viewBox="0 0 26 12" className="h-[12px] w-auto">
		<rect
			x="0.6"
			y="0.6"
			width="21"
			height="10.8"
			rx="2.4"
			fill="none"
			stroke="#1b1b1b"
			strokeOpacity="0.75"
			strokeWidth="1.2"
		/>
		<rect x="2.4" y="2.4" width="15" height="7.2" rx="1.4" fill="#1b1b1b" />
		<path d="M23.2 4v4c1-.25 1.7-.95 1.7-2s-.7-1.75-1.7-2Z" fill="#1b1b1b" />
	</svg>
);

const TaskbarApp = ({
	children,
	running,
	label,
}: {
	children: React.ReactNode;
	running?: boolean;
	label: string;
}) => (
	<span className="relative flex size-10 items-center justify-center rounded-[6px] transition-colors duration-150 hover:bg-black/[0.06]">
		{children}
		<span className="sr-only">{label}</span>
		<span
			className={classNames(
				"absolute bottom-[3px] h-[3px] rounded-full transition-all duration-200",
				running ? "w-4 bg-[#0078D4]" : "w-0 bg-transparent",
			)}
		/>
	</span>
);

export const WinTaskbar = ({
	recording,
	onSwitchOs,
}: {
	recording: boolean;
	onSwitchOs: () => void;
}) => (
	<div
		className="absolute inset-x-0 bottom-0 z-30 flex h-12 items-center px-3 text-[#1b1b1b]"
		style={{
			background: "rgba(243,243,243,0.86)",
			backdropFilter: "blur(28px)",
			WebkitBackdropFilter: "blur(28px)",
			borderTop: "1px solid rgba(255,255,255,0.6)",
			boxShadow: "0 -1px 12px rgba(0,0,0,0.10)",
			fontFamily: WIN_FONT,
		}}
	>
		<div className="flex-1" />
		<div className="flex items-center gap-1">
			<OsSwitchButton
				label="Switch the demo to macOS"
				tooltip="See the macOS version"
				side="above"
				onClick={onSwitchOs}
				className="size-10 rounded-[6px] hover:bg-black/[0.06]"
			>
				<StartGlyph />
			</OsSwitchButton>
			<TaskbarApp label="Search">
				<SearchGlyph />
			</TaskbarApp>
			<TaskbarApp label="File Explorer" running>
				<ExplorerGlyph />
			</TaskbarApp>
			<TaskbarApp label="Microsoft Edge">
				<EdgeGlyph />
			</TaskbarApp>
			<TaskbarApp label="Cap" running>
				<CapLogoMark className="size-[21px]" />
			</TaskbarApp>
		</div>

		<div className="flex flex-1 items-center justify-end gap-2.5">
			<span
				className={classNames(
					"flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-[11px] font-semibold tracking-[0.02em] transition-opacity duration-300",
					recording ? "opacity-100" : "opacity-0",
				)}
				style={{ background: "rgba(196,43,28,0.12)", color: "#c42b1c" }}
			>
				<span className="size-[7px] rounded-full bg-[#c42b1c]" />
				REC
			</span>
			<TrayChevron />
			<TrayWifi />
			<TraySpeaker />
			<TrayBattery />
			<span className="ml-1 flex flex-col items-end text-[11px] leading-[1.25] tabular-nums">
				<span>9:41 AM</span>
				<span>20/08/2026</span>
			</span>
		</div>
	</div>
);

const WinFolderIcon = () => (
	<svg aria-hidden="true" viewBox="0 0 64 52" className="h-11 w-auto">
		<path
			d="M2 10a5 5 0 0 1 5-5h13.6a5 5 0 0 1 3.6 1.5L27.4 10H57a5 5 0 0 1 5 5v3H2Z"
			fill="#E3A631"
		/>
		<path
			d="M2 16h60a4 4 0 0 1 3.95 4.66l-3.6 22A4 4 0 0 1 58.4 46H7.6a4 4 0 0 1-3.95-3.34l-3.6-22A4 4 0 0 1 2 16Z"
			fill="#FFC85C"
		/>
		<path
			d="M2 16h60a4 4 0 0 1 3.95 4.66l-.7 4.34H0.75L0.05 20.66A4 4 0 0 1 2 16Z"
			fill="#FFD684"
			opacity="0.75"
		/>
	</svg>
);

const WinDesktopFile = ({
	icon,
	label,
}: {
	icon: React.ReactNode;
	label: string;
}) => (
	<div className="flex w-[88px] flex-col items-center gap-1.5">
		{icon}
		<span
			className="max-w-full truncate rounded-[3px] px-1 text-center text-[11.5px] font-normal text-white"
			style={{
				fontFamily: WIN_FONT,
				textShadow: "0 1px 3px rgba(0,0,0,0.6)",
			}}
		>
			{label}
		</span>
	</div>
);

export const WinDesktopFiles = () => (
	// Kept on the right so the recorded window still owns the left half; a
	// Windows desktop lets icons live anywhere.
	<div className="absolute right-4 top-6 z-0 flex flex-col items-end gap-5">
		<WinDesktopFile icon={<WinFolderIcon />} label="Recordings" />
		<WinDesktopFile icon={<CapFileIcon />} label="team-update.cap" />
		<WinDesktopFile icon={<ImageFileIcon />} label="Q3 launch.png" />
	</div>
);
