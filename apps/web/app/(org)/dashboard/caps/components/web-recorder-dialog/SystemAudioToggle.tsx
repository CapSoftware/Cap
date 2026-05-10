"use client";

import clsx from "clsx";
import { Volume2Icon, VolumeOffIcon } from "lucide-react";
import type { RecordingMode } from "./RecordingModeSelector";

interface SystemAudioToggleProps {
	enabled: boolean;
	disabled?: boolean;
	recordingMode: RecordingMode;
	unavailableReason?: string | null;
	onToggle: (enabled: boolean) => void;
}

const SYSTEM_AUDIO_HINTS: Partial<Record<RecordingMode, string>> = {
	fullscreen: 'Make sure to check "Share system audio" in the browser picker.',
	window: "System audio may not be available when sharing a window.",
};

export const SystemAudioToggle = ({
	enabled,
	disabled = false,
	recordingMode,
	unavailableReason = null,
	onToggle,
}: SystemAudioToggleProps) => {
	const unavailable = Boolean(unavailableReason);
	const Icon = enabled && !unavailable ? Volume2Icon : VolumeOffIcon;
	const hint =
		unavailableReason ??
		(enabled ? SYSTEM_AUDIO_HINTS[recordingMode] : undefined);
	const toggleDisabled = disabled || unavailable;

	return (
		<div className="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
			<button
				type="button"
				disabled={toggleDisabled}
				onClick={() => onToggle(!enabled)}
				className={clsx(
					"relative flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border border-gray-3 rounded-lg w-full transition-colors overflow-hidden font-normal text-[0.875rem] text-[--text-primary] disabled:text-gray-11",
					toggleDisabled
						? "cursor-default"
						: "cursor-pointer hover:bg-gray-3/50",
				)}
			>
				<Icon className="size-4 text-gray-11 shrink-0" />
				<span className="flex-1 text-left truncate">System Audio</span>
				<span
					className={clsx(
						"px-[0.375rem] h-[1.25rem] min-w-[2.5rem] rounded-full text-[0.75rem] leading-[1.25rem] flex items-center justify-center font-normal transition-colors duration-200",
						enabled && !unavailable
							? "bg-[var(--blue-3)] text-[var(--blue-11)] dark:bg-[var(--blue-4)] dark:text-[var(--blue-12)]"
							: "bg-[var(--red-3)] text-[var(--red-11)] dark:bg-[var(--red-4)] dark:text-[var(--red-12)]",
					)}
				>
					{unavailable ? "Unavailable" : enabled ? "On" : "Off"}
				</span>
			</button>
			{hint && (
				<p className="text-[0.6875rem] leading-snug text-gray-10 px-[0.375rem]">
					{hint}
				</p>
			)}
		</div>
	);
};
