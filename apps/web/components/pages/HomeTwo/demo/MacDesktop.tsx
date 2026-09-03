"use client";

import { classNames } from "@cap/utils/helpers";
import type { RefObject } from "react";
import { AppleGlyph } from "../glyphs";
import { CapLogoMark } from "./capIcons";
import {
	OsSwitchButton,
	TrafficLights,
	WindowsCaptionControls,
} from "./chrome";
import { useIsWindowsDemo } from "./platform";

/**
 * The fake macOS environment the demo plays inside: menu bar, desktop files,
 * dock, and the little app window that gets recorded. All chrome is drawn in
 * CSS/SVG so it stays crisp at any scale.
 */

/* ------------------------------------------------------------- menu bar -- */

const MenuGlyph = ({ children }: { children: React.ReactNode }) => (
	<span className="flex h-full items-center opacity-80">{children}</span>
);

export const MenuBar = ({
	recording,
	onSwitchOs,
}: {
	recording: boolean;
	onSwitchOs: () => void;
}) => (
	<div
		className="relative z-30 flex h-7 w-full items-center gap-4 px-4 text-[12.5px] font-medium text-[#1d1d1f] backdrop-blur-md"
		style={{
			background: "rgba(255,255,255,0.55)",
			fontFamily:
				"-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
		}}
	>
		<OsSwitchButton
			label="Switch the demo to Windows"
			tooltip="See the Windows version"
			align="left"
			onClick={onSwitchOs}
			className="-mx-1.5 h-7 rounded-[5px] px-1.5 hover:bg-black/[0.07]"
		>
			<AppleGlyph className="size-[13px]" />
		</OsSwitchButton>
		<span className="-ml-2.5 font-semibold">Cap</span>
		{["File", "Edit", "View", "Window", "Help"].map((item) => (
			<span key={item} className="hidden opacity-90 lg:inline">
				{item}
			</span>
		))}
		<span className="flex-1" />

		{/* macOS screen-recording indicator */}
		<span
			className={classNames(
				"flex items-center gap-1 rounded-full px-1.5 py-[1px] transition-opacity duration-300",
				recording ? "opacity-100" : "opacity-0",
			)}
			style={{ background: "rgba(88,86,214,0.16)" }}
		>
			<svg aria-hidden="true" viewBox="0 0 14 14" className="size-3">
				<rect
					x="1"
					y="1"
					width="12"
					height="12"
					rx="3.5"
					fill="none"
					stroke="#5856D6"
					strokeWidth="1.6"
				/>
				<circle cx="7" cy="7" r="2.4" fill="#5856D6" />
			</svg>
		</span>

		{/* battery */}
		<MenuGlyph>
			<svg aria-hidden="true" viewBox="0 0 26 12" className="h-[11px] w-auto">
				<rect
					x="0.5"
					y="0.5"
					width="21"
					height="11"
					rx="3"
					fill="none"
					stroke="currentColor"
					strokeOpacity="0.5"
				/>
				<rect x="2" y="2" width="15" height="8" rx="1.6" fill="currentColor" />
				<path
					d="M23 4v4c1.2-.3 2-1 2-2s-.8-1.7-2-2Z"
					fill="currentColor"
					fillOpacity="0.5"
				/>
			</svg>
		</MenuGlyph>
		{/* wifi */}
		<MenuGlyph>
			<svg aria-hidden="true" viewBox="0 0 16 12" className="h-[11px] w-auto">
				<path d="M8 10.8 1.2 4a9.6 9.6 0 0 1 13.6 0Z" fill="none" />
				<path
					d="M8 11.2 0.8 4.1C2.7 2.2 5.2 1 8 1s5.3 1.2 7.2 3.1Z"
					fill="currentColor"
				/>
			</svg>
		</MenuGlyph>
		{/* search */}
		<MenuGlyph>
			<svg aria-hidden="true" viewBox="0 0 24 24" className="size-[13px]">
				<circle
					cx="11"
					cy="11"
					r="7"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.4"
				/>
				<path
					d="m20.5 20.5-4-4"
					stroke="currentColor"
					strokeWidth="2.4"
					strokeLinecap="round"
				/>
			</svg>
		</MenuGlyph>
		{/* control centre */}
		<MenuGlyph>
			<svg aria-hidden="true" viewBox="0 0 24 24" className="size-[13px]">
				<rect
					x="2"
					y="4"
					width="20"
					height="7"
					rx="3.5"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
				/>
				<circle cx="6" cy="7.5" r="2" fill="currentColor" />
				<rect
					x="2"
					y="13"
					width="20"
					height="7"
					rx="3.5"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
				/>
				<circle cx="18" cy="16.5" r="2" fill="currentColor" />
			</svg>
		</MenuGlyph>
		<span className="whitespace-nowrap tabular-nums opacity-90">
			Thu 20 Aug&nbsp;&nbsp;9:41 AM
		</span>
	</div>
);

/* -------------------------------------------------------- desktop files -- */

const FolderIcon = () => (
	<svg
		aria-hidden="true"
		viewBox="0 0 64 52"
		className="h-11 w-auto drop-shadow-sm"
	>
		<path
			d="M4 8a5 5 0 0 1 5-5h14.2a5 5 0 0 1 3.8 1.7L30.4 9H55a5 5 0 0 1 5 5v2H4Z"
			fill="#4BA3F2"
		/>
		<rect x="4" y="12" width="56" height="36" rx="5" fill="#6FB9F7" />
		<rect
			x="4"
			y="12"
			width="56"
			height="10"
			rx="5"
			fill="#83C4F9"
			opacity="0.8"
		/>
	</svg>
);

export const CapFileIcon = () => (
	<span className="relative flex h-11 w-9 items-center justify-center rounded-[6px] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)]">
		<span
			className="absolute right-0 top-0 h-3 w-3 rounded-bl-[6px]"
			style={{ background: "#e3e6ec" }}
		/>
		<CapLogoMark className="size-5" />
	</span>
);

export const ImageFileIcon = () => (
	<span className="relative flex h-11 w-9 items-center justify-center overflow-hidden rounded-[6px] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)]">
		<span
			className="absolute inset-1 rounded-[3px]"
			style={{
				background:
					"linear-gradient(160deg, #8fc1f7 0%, #dad0f8 55%, #f6d9ec 100%)",
			}}
		/>
		<span className="absolute bottom-1.5 left-2 size-2 rounded-full bg-white/80" />
	</span>
);

const DesktopFile = ({
	icon,
	label,
}: {
	icon: React.ReactNode;
	label: string;
}) => (
	<div className="flex w-[86px] flex-col items-center gap-1">
		{icon}
		<span
			className="max-w-full truncate rounded px-1 text-center text-[11px] font-medium text-white"
			style={{
				fontFamily:
					"-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
				textShadow: "0 1px 2px rgba(0,0,0,0.45)",
			}}
		>
			{label}
		</span>
	</div>
);

export const DesktopFiles = () => (
	<div className="absolute right-4 top-14 z-0 flex flex-col items-end gap-5">
		<DesktopFile icon={<FolderIcon />} label="Recordings" />
		<DesktopFile icon={<CapFileIcon />} label="team-update.cap" />
		<DesktopFile icon={<ImageFileIcon />} label="Q3 launch.png" />
	</div>
);

/* ----------------------------------------------------------------- dock -- */

const FinderIcon = () => (
	<svg aria-hidden="true" viewBox="0 0 48 48" className="size-full">
		<rect width="48" height="48" rx="11" fill="#3C9BF4" />
		<path
			d="M27 0h10a11 11 0 0 1 11 11v26a11 11 0 0 1-11 11H27Z"
			fill="#2478D4"
		/>
		<path d="M27 0v48" stroke="#1d64b8" strokeWidth="1.4" />
		<path
			d="M14 14v8M36 14v8"
			stroke="#fff"
			strokeWidth="3"
			strokeLinecap="round"
		/>
		<path
			d="M12 32c4 4.5 9 6.5 14 6.5S36 36.5 40 32"
			fill="none"
			stroke="#fff"
			strokeWidth="3"
			strokeLinecap="round"
		/>
	</svg>
);

const SafariIcon = () => (
	<svg aria-hidden="true" viewBox="0 0 48 48" className="size-full">
		<rect width="48" height="48" rx="11" fill="#f2f4f8" />
		<circle cx="24" cy="24" r="18" fill="url(#ht-safari)" />
		<path d="m33 15-6.2 6.8-5.6 5.6L15 33l6.8-6.2 5.6-5.6Z" fill="#fff" />
		<path d="m33 15-11.2 6.8 5.6 5.6Z" fill="#FF3B30" />
		<defs>
			{/* biome-ignore lint/correctness/useUniqueElementIds: single-instance decorative svg defs */}
			<linearGradient id="ht-safari" x1="24" y1="6" x2="24" y2="42">
				<stop stopColor="#3FA9F5" />
				<stop offset="1" stopColor="#1B6FE0" />
			</linearGradient>
		</defs>
	</svg>
);

const MessagesIcon = () => (
	<svg aria-hidden="true" viewBox="0 0 48 48" className="size-full">
		<rect width="48" height="48" rx="11" fill="url(#ht-msg)" />
		<path
			d="M24 10c-8.8 0-16 5.6-16 12.6 0 4.4 2.9 8.3 7.3 10.5-.3 1.9-1.3 3.6-2.8 4.9 2.7-.3 5.2-1.4 7.1-3 1.4.3 2.9.4 4.4.4 8.8 0 16-5.6 16-12.8S32.8 10 24 10Z"
			fill="#fff"
		/>
		<defs>
			{/* biome-ignore lint/correctness/useUniqueElementIds: single-instance decorative svg defs */}
			<linearGradient id="ht-msg" x1="24" y1="0" x2="24" y2="48">
				<stop stopColor="#5BF675" />
				<stop offset="1" stopColor="#0DBC2C" />
			</linearGradient>
		</defs>
	</svg>
);

const NotesIcon = () => (
	<svg aria-hidden="true" viewBox="0 0 48 48" className="size-full">
		<rect width="48" height="48" rx="11" fill="#fff" />
		<rect width="48" height="14" rx="11" fill="#FBBC49" />
		<rect y="10" width="48" height="4" fill="#FBBC49" />
		<path
			d="M10 22h28M10 29h28M10 36h18"
			stroke="#d9dbe1"
			strokeWidth="2.4"
			strokeLinecap="round"
		/>
	</svg>
);

const TrashIcon = () => (
	<svg aria-hidden="true" viewBox="0 0 48 48" className="size-full">
		<path
			d="M12 14h24l-2.2 26.2a4 4 0 0 1-4 3.8H18.2a4 4 0 0 1-4-3.8Z"
			fill="url(#ht-trash)"
		/>
		<rect x="9" y="9" width="30" height="5" rx="2.5" fill="#c8cdd6" />
		<path
			d="M19 19v19M24 19v19M29 19v19"
			stroke="#8f96a3"
			strokeWidth="1.6"
			strokeLinecap="round"
		/>
		<defs>
			{/* biome-ignore lint/correctness/useUniqueElementIds: single-instance decorative svg defs */}
			<linearGradient id="ht-trash" x1="24" y1="14" x2="24" y2="44">
				<stop stopColor="#e6e9ee" />
				<stop offset="1" stopColor="#b9bfc9" />
			</linearGradient>
		</defs>
	</svg>
);

const DockApp = ({
	children,
	running,
}: {
	children: React.ReactNode;
	running?: boolean;
}) => (
	<div className="relative flex flex-col items-center">
		<span className="size-11 transition-transform duration-200">
			{children}
		</span>
		<span
			className={classNames(
				"absolute -bottom-[5px] size-[3px] rounded-full bg-black/40",
				running ? "opacity-100" : "opacity-0",
			)}
		/>
	</div>
);

export const Dock = () => (
	<div className="absolute bottom-2 left-1/2 z-30 -translate-x-1/2">
		<div
			className="flex items-center gap-2.5 rounded-2xl border border-white/40 px-2.5 py-1.5 pb-2 backdrop-blur-xl"
			style={{
				background: "rgba(255,255,255,0.38)",
				boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
			}}
		>
			<DockApp running>
				<FinderIcon />
			</DockApp>
			<DockApp>
				<SafariIcon />
			</DockApp>
			<DockApp>
				<MessagesIcon />
			</DockApp>
			<DockApp>
				<NotesIcon />
			</DockApp>
			<DockApp running>
				<CapLogoMark className="size-full drop-shadow-sm" />
			</DockApp>
			<span className="mx-0.5 h-9 w-px rounded-full bg-black/15" />
			<DockApp>
				<TrashIcon />
			</DockApp>
		</div>
	</div>
);

/* -------------------------------------------- the window being recorded -- */

const SkeletonBar = ({
	w,
	tone = "rgba(17,17,17,0.08)",
	h = 8,
}: {
	w: number | string;
	tone?: string;
	h?: number;
}) => (
	<span
		className="block rounded-full"
		style={{ width: w, height: h, background: tone }}
	/>
);

/**
 * A generic macOS app window (a little analytics dashboard) that plays the
 * part of "the thing you're recording". The inner content scrolls via
 * `scrollRef` while the demo cursor "works".
 */
export const ContentWindow = ({
	width,
	height,
	scrollRef,
}: {
	width: number;
	height: number;
	scrollRef: RefObject<HTMLDivElement | null>;
}) => {
	const isWindows = useIsWindowsDemo();
	return (
		<div
			className="absolute overflow-hidden"
			style={{
				width,
				height,
				borderRadius: isWindows ? 8 : 10,
				background: "#ffffff",
				border: "1px solid rgba(0,0,0,0.1)",
				boxShadow: "0 22px 60px rgba(0,0,0,0.18), 0 3px 12px rgba(0,0,0,0.08)",
			}}
		>
			{/* titlebar */}
			<div
				className={classNames(
					"flex h-10 items-center gap-2 border-b",
					isWindows ? "pl-3.5" : "px-3.5",
				)}
				style={{
					background: isWindows ? "#f3f3f3" : "#f6f7f9",
					borderColor: "rgba(0,0,0,0.07)",
				}}
			>
				{isWindows ? null : <TrafficLights />}
				<div className="flex flex-1 justify-center">
					<span
						className="flex h-6 w-[46%] items-center justify-center gap-1.5 rounded-md text-[11px]"
						style={{
							background: "rgba(17,17,17,0.05)",
							color: "rgba(17,17,17,0.55)",
						}}
					>
						<svg aria-hidden="true" viewBox="0 0 24 24" className="size-2.5">
							<rect
								x="5"
								y="10"
								width="14"
								height="10"
								rx="2"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
							/>
							<path
								d="M8 10V7a4 4 0 0 1 8 0v3"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
							/>
						</svg>
						acme.com/dashboard
					</span>
				</div>
				{isWindows ? (
					<WindowsCaptionControls className="h-10" />
				) : (
					<span className="w-12" />
				)}
			</div>

			{/* app body */}
			<div className="flex h-[calc(100%-40px)]">
				{/* sidebar */}
				<div
					className="flex w-[52px] shrink-0 flex-col items-center gap-4 border-r pt-4"
					style={{ borderColor: "rgba(0,0,0,0.06)", background: "#fafbfc" }}
				>
					<span
						className="size-6 rounded-[7px]"
						style={{ background: "linear-gradient(135deg,#8FC1F7,#3D77C2)" }}
					/>
					{[0.14, 0.08, 0.08, 0.08].map((o, i) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
							key={i}
							className="size-4 rounded-md"
							style={{ background: `rgba(17,17,17,${o})` }}
						/>
					))}
				</div>

				{/* scrollable main */}
				<div className="relative flex-1 overflow-hidden">
					<div
						ref={scrollRef}
						className="absolute inset-x-0 top-0 will-change-transform"
					>
						<div className="flex flex-col gap-5 p-5">
							<div className="flex items-center justify-between">
								<div className="flex flex-col gap-2">
									<SkeletonBar w={150} h={13} tone="rgba(17,17,17,0.75)" />
									<SkeletonBar w={96} h={7} tone="rgba(17,17,17,0.25)" />
								</div>
								<span
									className="h-7 w-20 rounded-lg"
									style={{
										background: "linear-gradient(180deg,#71a3f5,#3f7fd2)",
									}}
								/>
							</div>

							<div className="grid grid-cols-3 gap-3">
								{["#E4F0FB", "#EFE9FB", "#E5F3EC"].map((bg) => (
									<div
										key={bg}
										className="flex flex-col gap-2.5 rounded-xl p-3"
										style={{ background: bg }}
									>
										<SkeletonBar w="55%" h={7} tone="rgba(17,17,17,0.3)" />
										<SkeletonBar w="38%" h={13} tone="rgba(17,17,17,0.7)" />
									</div>
								))}
							</div>

							{/* chart card */}
							<div
								className="rounded-xl border p-4"
								style={{ borderColor: "rgba(0,0,0,0.08)" }}
							>
								<SkeletonBar w={110} h={8} tone="rgba(17,17,17,0.5)" />
								<div className="mt-4 flex h-24 items-end gap-2">
									{[
										0.35, 0.5, 0.42, 0.62, 0.55, 0.74, 0.66, 0.88, 0.79, 0.95,
										0.85, 1,
									].map((h, i) => (
										<span
											// biome-ignore lint/suspicious/noArrayIndexKey: static chart
											key={i}
											className="flex-1 rounded-t-md"
											style={{
												height: `${h * 100}%`,
												background:
													i % 3 === 2
														? "rgba(143,193,247,0.9)"
														: "rgba(143,193,247,0.45)",
											}}
										/>
									))}
								</div>
							</div>

							{/* table rows (revealed as the cursor scrolls) */}
							<div
								className="rounded-xl border"
								style={{ borderColor: "rgba(0,0,0,0.08)" }}
							>
								{[0, 1, 2, 3, 4].map((row) => (
									<div
										key={row}
										className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
										style={{ borderColor: "rgba(0,0,0,0.05)" }}
									>
										<span
											className="size-6 rounded-full"
											style={{
												background: [
													"#BFDCFC",
													"#DACBF9",
													"#BFEDD8",
													"#FFD9AC",
													"#F6D9EC",
												][row],
											}}
										/>
										<SkeletonBar
											w={`${34 - row * 3}%`}
											h={7}
											tone="rgba(17,17,17,0.35)"
										/>
										<span className="flex-1" />
										<SkeletonBar w={44} h={7} tone="rgba(17,17,17,0.15)" />
									</div>
								))}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};
