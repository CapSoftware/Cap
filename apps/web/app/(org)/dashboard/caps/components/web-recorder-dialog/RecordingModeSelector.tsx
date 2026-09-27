"use client";

import clsx from "clsx";
import { CameraIcon, type LucideIcon, MonitorIcon } from "lucide-react";

export type RecordingMode = "fullscreen" | "window" | "tab" | "camera";

const OPTIONS: Array<{
	value: "fullscreen" | "camera";
	label: string;
	hint: string;
	icon: LucideIcon;
}> = [
	{
		value: "fullscreen",
		label: "Screen",
		hint: "Screen, window or tab",
		icon: MonitorIcon,
	},
	{ value: "camera", label: "Camera only", hint: "Just you", icon: CameraIcon },
];

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
}: RecordingModeSelectorProps) => {
	const current = mode === "camera" ? "camera" : "fullscreen";
	return (
		<fieldset className="grid grid-cols-2 gap-2">
			<legend className="sr-only">What to record</legend>
			{OPTIONS.map(({ value, label, hint, icon: Icon }) => {
				const selected = value === current;
				const unavailable = value !== "camera" && !displayRecordingSupported;
				return (
					<button
						key={value}
						type="button"
						aria-pressed={selected}
						disabled={disabled || unavailable}
						onClick={() => onModeChange(value)}
						className={clsx(
							"flex min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-8 disabled:cursor-not-allowed",
							selected
								? "border-blue-9 bg-blue-2 ring-1 ring-blue-9"
								: "border-gray-4 bg-gray-1 hover:border-gray-6",
							unavailable && "opacity-40",
						)}
					>
						<Icon
							className={clsx(
								"size-5 shrink-0",
								selected ? "text-blue-10" : "text-gray-10",
							)}
							aria-hidden
						/>
						<span className="flex min-w-0 flex-col">
							<span className="truncate text-[0.875rem] font-medium text-gray-12">
								{label}
							</span>
							<span className="truncate text-[0.75rem] text-gray-10">
								{unavailable ? "Needs a computer" : hint}
							</span>
						</span>
					</button>
				);
			})}
		</fieldset>
	);
};
