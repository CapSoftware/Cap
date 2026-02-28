"use client";

import {
	SelectContent,
	SelectItem,
	SelectRoot,
	SelectTrigger,
	SelectValue,
} from "@cap/ui";
import {
	CameraIcon,
	Globe,
	type LucideIcon,
	MonitorIcon,
	RectangleHorizontal,
} from "lucide-react";

export type RecordingMode = "fullscreen" | "window" | "tab" | "camera";

interface RecordingModeSelectorProps {
	mode: RecordingMode;
	disabled?: boolean;
	onModeChange: (mode: RecordingMode) => void;
}

export const RecordingModeSelector = ({
	mode,
	disabled = false,
	onModeChange,
}: RecordingModeSelectorProps) => {
	const recordingModeOptions: Record<
		RecordingMode,
		{
			label: string;
			displayLabel: string;
			icon: LucideIcon;
		}
	> = {
		fullscreen: {
			label: "Full Screen (Recommended)",
			displayLabel: "Full Screen",
			icon: MonitorIcon,
		},
		window: {
			label: "Window",
			displayLabel: "Window",
			icon: RectangleHorizontal,
		},
		tab: {
			label: "Current tab",
			displayLabel: "Current tab",
			icon: Globe,
		},
		camera: {
			label: "Camera only",
			displayLabel: "Camera only",
			icon: CameraIcon,
		},
	};

	const selectedOption = mode ? recordingModeOptions[mode] : null;
	const SelectedIcon = selectedOption?.icon;

	return (
		<div className="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary] max-w-full">
			<SelectRoot
				value={mode}
				onValueChange={(value) => {
					onModeChange(value as RecordingMode);
				}}
				disabled={disabled}
			>
				<SelectTrigger className="relative flex flex-row items-center h-[2rem] px-[0.375rem] border border-gray-3 rounded-lg w-full max-w-[280px] disabled:text-gray-11 transition-colors overflow-hidden z-10 font-normal text-[0.875rem] bg-transparent hover:bg-transparent focus:bg-transparent focus:border-gray-3 hover:border-gray-3 text-[--text-primary] [&>svg]:hidden">
					<SelectValue
						placeholder="Select recording mode"
						className="flex w-full items-center gap-[0.375rem] text-left truncate"
					>
						{selectedOption && SelectedIcon && (
							<span className="flex items-center gap-[0.375rem]">
								<SelectedIcon className="size-4 text-gray-11 shrink-0" />
								{selectedOption.displayLabel}
							</span>
						)}
					</SelectValue>
				</SelectTrigger>
				<SelectContent className="z-[502] max-w-[320px]">
					{Object.entries(recordingModeOptions).map(([value, option]) => {
						const OptionIcon = option.icon;
						const isFullscreen = value === "fullscreen";

						return (
							<SelectItem key={value} value={value}>
								<span className="flex flex-col gap-0.5">
									<span className="flex items-center gap-2">
										<OptionIcon className="size-4 text-gray-11" />
										{option.label}
									</span>
									{isFullscreen && (
										<span className="text-xs italic text-gray-10 pl-6">
											Recommended to capture camera window when picture in
											picture is activated
										</span>
									)}
								</span>
							</SelectItem>
						);
					})}
				</SelectContent>
			</SelectRoot>
		</div>
	);
};
