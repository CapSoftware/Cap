"use client";

import clsx from "clsx";
import {
	AppWindowIcon,
	CameraIcon,
	Globe,
	type LucideIcon,
	MonitorIcon,
} from "lucide-react";

export type RecordingMode = "fullscreen" | "window" | "tab" | "camera";

export const RECORDING_MODE_OPTIONS: Record<
	RecordingMode,
	{ label: string; icon: LucideIcon }
> = {
	fullscreen: { label: "Screen", icon: MonitorIcon },
	window: { label: "Window", icon: AppWindowIcon },
	tab: { label: "This tab", icon: Globe },
	camera: { label: "Camera only", icon: CameraIcon },
};

const MODE_ORDER: RecordingMode[] = ["fullscreen", "window", "tab", "camera"];

interface RecordingModeSelectorProps {
	mode: RecordingMode;
	disabled?: boolean;
	displayRecordingSupported?: boolean;
	onModeChange: (mode: RecordingMode) => void;
}

export const RecordingModeSelector = ({
	mode,
	disabled = false,
	displayRecordingSupported = true,
	onModeChange,
}: RecordingModeSelectorProps) => (
	<fieldset className="grid grid-cols-4 gap-1 rounded-xl bg-gray-3 p-1">
		<legend className="sr-only">What to record</legend>
		{MODE_ORDER.map((value) => {
			const option = RECORDING_MODE_OPTIONS[value];
			const Icon = option.icon;
			const selected = value === mode;
			const unavailable = value !== "camera" && !displayRecordingSupported;
			return (
				<button
					key={value}
					type="button"
					aria-pressed={selected}
					disabled={disabled || unavailable}
					title={
						unavailable ? "Screen recording needs a desktop browser" : undefined
					}
					onClick={() => onModeChange(value)}
					className={clsx(
						"flex min-w-0 flex-col items-center justify-center gap-1 rounded-[9px] px-1 py-2 text-[0.75rem] font-medium leading-none transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-8 disabled:cursor-not-allowed",
						selected
							? "bg-gray-1 text-gray-12 shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_var(--gray-4)]"
							: "text-gray-10 hover:bg-gray-4 hover:text-gray-12",
						unavailable && "opacity-40 hover:bg-transparent",
					)}
				>
					<Icon
						className={clsx(
							"size-4 shrink-0",
							selected ? "text-blue-10" : "text-current",
						)}
						aria-hidden
					/>
					<span className="max-w-full truncate">{option.label}</span>
				</button>
			);
		})}
	</fieldset>
);
