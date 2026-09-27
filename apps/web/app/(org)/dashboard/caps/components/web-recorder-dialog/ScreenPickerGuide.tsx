"use client";

import clsx from "clsx";
import {
	CameraIcon,
	type LucideIcon,
	MicIcon,
	MonitorIcon,
	Volume2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { TRACK_COLORS } from "./RecorderStage";
import type { RecordingMode } from "./RecordingModeSelector";

type DisplayMode = Exclude<RecordingMode, "camera">;

const COPY: Record<DisplayMode, { title: string; body: string }> = {
	fullscreen: {
		title: "Pick the screen, window or tab to record",
		body: "Select it in your browser's sharing popup, then click Share.",
	},
	window: {
		title: "Pick the window to record",
		body: "Select it in your browser's sharing popup, then click Share.",
	},
	tab: {
		title: "Click Share to record this tab",
		body: "Your browser asks before any tab can be recorded.",
	},
};

const PANES: Record<DisplayMode, number> = { tab: 0, window: 1, fullscreen: 2 };

interface ScreenPickerGuideProps {
	open: boolean;
	mode: RecordingMode;
	cameraEnabled: boolean;
	micEnabled: boolean;
	systemAudioEnabled: boolean;
}

const Track = ({
	icon: Icon,
	color,
	label,
}: {
	icon: LucideIcon;
	color: string;
	label: string;
}) => (
	<span className="inline-flex items-center gap-1 rounded-full bg-gray-3 py-1 pl-1.5 pr-2.5 text-[0.75rem] font-medium text-gray-12">
		<span
			className="flex size-4 items-center justify-center rounded-full"
			style={{ backgroundColor: `${color}26` }}
		>
			<Icon className="size-2.5" style={{ color }} aria-hidden />
		</span>
		{label}
	</span>
);

const PickerIllustration = ({ mode }: { mode: DisplayMode }) => {
	const activePane = PANES[mode];
	return (
		<div
			aria-hidden
			className="picker-guide relative mx-auto w-full max-w-[20rem] select-none overflow-hidden rounded-xl bg-gray-1 p-3 shadow-[0_18px_40px_-18px_rgba(0,0,0,0.45)] ring-1 ring-gray-4"
		>
			<div className="mb-2 h-2 w-[46%] rounded bg-gray-6" />
			<div className="mb-2.5 flex gap-3 border-b border-gray-4 pb-1.5">
				{["Chrome tab", "Window", "Entire screen"].map((label, index) => (
					<span
						key={label}
						className={clsx(
							"relative text-[0.625rem] font-medium",
							index === activePane ? "text-blue-11" : "text-gray-9",
						)}
					>
						{label}
						{index === activePane && (
							<span className="absolute -bottom-[7px] left-0 right-0 h-0.5 rounded-full bg-blue-9" />
						)}
					</span>
				))}
			</div>
			<div className="grid grid-cols-3 gap-2">
				{[0, 1, 2].map((tile) => (
					<div
						key={tile}
						className={clsx(
							"relative aspect-[16/10] rounded-md bg-gray-3 ring-1 ring-gray-4",
							tile === 1 && "picker-guide-target",
						)}
					>
						<div className="absolute inset-[14%] rounded-sm bg-gray-5" />
					</div>
				))}
			</div>
			<div className="mt-3 flex justify-end gap-1.5">
				<span className="rounded-md px-2.5 py-1 text-[0.625rem] font-medium text-gray-10 ring-1 ring-gray-5">
					Cancel
				</span>
				<span className="picker-guide-share rounded-md bg-blue-9 px-2.5 py-1 text-[0.625rem] font-medium text-white">
					Share
				</span>
			</div>
			<svg
				viewBox="0 0 16 20"
				className="picker-guide-cursor absolute size-4 drop-shadow-[0_1px_1px_rgba(0,0,0,0.4)]"
			>
				<title>Pointer</title>
				<path
					d="M1 1l0 15 4-3.6 2.7 6 2.6-1.1-2.7-5.9 5.4-.4z"
					fill="#fff"
					stroke="#111"
					strokeWidth="1.2"
					strokeLinejoin="round"
				/>
			</svg>
			<style>{`
				.picker-guide-cursor { left: 12%; top: 88%; animation: picker-cursor 3.6s cubic-bezier(.45,0,.2,1) infinite; }
				@keyframes picker-cursor {
					0% { left: 12%; top: 88%; opacity: 0; }
					8% { opacity: 1; }
					30%, 42% { left: 48%; top: 52%; }
					34% { transform: scale(.85); }
					38% { transform: scale(1); }
					68%, 86% { left: 88%; top: 88%; opacity: 1; }
					72% { transform: scale(.85); }
					76% { transform: scale(1); }
					100% { left: 88%; top: 88%; opacity: 0; }
				}
				.picker-guide-target { animation: picker-target 3.6s ease infinite; }
				@keyframes picker-target {
					0%, 33% { box-shadow: 0 0 0 0 transparent; }
					36%, 94% { box-shadow: 0 0 0 2px var(--blue-9); }
					100% { box-shadow: 0 0 0 0 transparent; }
				}
				.picker-guide-share { animation: picker-share 3.6s ease infinite; }
				@keyframes picker-share {
					0%, 70% { filter: none; transform: scale(1); }
					73% { filter: brightness(.85); transform: scale(.96); }
					78%, 100% { filter: none; transform: scale(1); }
				}
				@media (prefers-reduced-motion: reduce) {
					.picker-guide-cursor { animation: none; left: 88%; top: 88%; }
					.picker-guide-target { animation: none; box-shadow: 0 0 0 2px var(--blue-9); }
					.picker-guide-share { animation: none; }
				}
			`}</style>
		</div>
	);
};

export const ScreenPickerGuide = ({
	open,
	mode,
	cameraEnabled,
	micEnabled,
	systemAudioEnabled,
}: ScreenPickerGuideProps) => {
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

	if (!mounted || !open || mode === "camera") return null;
	const copy = COPY[mode];

	return createPortal(
		<output
			aria-live="polite"
			className="pointer-events-none fixed inset-x-0 bottom-0 z-[600] flex justify-center px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
		>
			<div className="animate-fadeIn flex w-full max-w-[26rem] flex-col gap-4 rounded-2xl border border-gray-4 bg-gray-2 p-5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.5)]">
				<PickerIllustration mode={mode} />
				<div className="flex flex-col gap-1 text-center">
					<p className="text-balance text-[0.9375rem] font-semibold text-gray-12">
						{copy.title}
					</p>
					<p className="text-[0.8125rem] leading-snug text-gray-10">
						{copy.body}
					</p>
				</div>
				<div className="flex flex-col items-center gap-2 border-t border-gray-4 pt-3">
					<p className="text-[0.75rem] text-gray-10">
						Cap records each of these on its own track
					</p>
					<div className="flex flex-wrap justify-center gap-1.5">
						<Track
							icon={MonitorIcon}
							color={TRACK_COLORS.screen}
							label="Screen"
						/>
						{cameraEnabled && (
							<Track
								icon={CameraIcon}
								color={TRACK_COLORS.camera}
								label="Camera"
							/>
						)}
						{micEnabled && (
							<Track icon={MicIcon} color={TRACK_COLORS.mic} label="Mic" />
						)}
						{systemAudioEnabled && (
							<Track
								icon={Volume2Icon}
								color={TRACK_COLORS.systemAudio}
								label="System audio"
							/>
						)}
					</div>
				</div>
			</div>
		</output>,
		document.body,
	);
};
