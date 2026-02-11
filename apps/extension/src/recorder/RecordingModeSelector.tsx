"use client";

import {
	SelectContent,
	SelectItem,
	SelectRoot,
	SelectTrigger,
	SelectValue,
} from "@cap/ui";
import clsx from "clsx";
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
	variant?: "default" | "compact";
	includeCameraOption?: boolean;
	onModeChange: (mode: RecordingMode) => void;
}

export const RecordingModeSelector = ({
	mode,
	disabled = false,
	variant = "default",
	includeCameraOption = true,
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
	const options = includeCameraOption
		? Object.entries(recordingModeOptions)
		: Object.entries(recordingModeOptions).filter(
				([value]) => value !== "camera",
			);
	const compact = variant === "compact";

	return (
		<div
			className={clsx(
				"flex flex-col items-stretch max-w-full",
				compact
					? "w-full text-gray-900"
					: "gap-[0.25rem] text-[--text-primary]",
			)}
		>
			<SelectRoot
				value={mode}
				onValueChange={(value) => {
					onModeChange(value as RecordingMode);
				}}
				disabled={disabled}
			>
				<SelectTrigger
					className={clsx(
						"relative flex flex-row items-center overflow-hidden z-10 font-normal [&>svg]:hidden",
						compact
							? "h-[2.8rem] w-full rounded-[14px] border border-gray-200 bg-white px-[0.5rem] text-gray-900 transition-colors hover:bg-gray-50 focus:border-gray-300"
							: "h-[2rem] px-[0.375rem] border border-gray-3 rounded-lg w-full max-w-[280px] disabled:text-gray-11 transition-colors text-[0.875rem] bg-transparent hover:bg-transparent focus:bg-transparent focus:border-gray-3 hover:border-gray-3 text-[--text-primary]",
					)}
				>
					<SelectValue
						placeholder="Select recording mode"
						className={clsx(
							"flex w-full items-center text-left truncate",
							compact ? "gap-2" : "gap-[0.375rem]",
						)}
					>
						{selectedOption && SelectedIcon && (
							<span
								className={clsx(
									"flex items-center",
									compact
										? "w-full flex-col justify-center gap-0.5"
										: "gap-[0.375rem]",
								)}
							>
								<SelectedIcon
									className={clsx(
										"shrink-0",
										compact ? "size-4 text-gray-400" : "size-4 text-gray-11",
									)}
								/>
								<span
									className={clsx(
										"block truncate",
										compact ? "text-[0.7rem]" : "",
									)}
								>
									{selectedOption.displayLabel}
								</span>
							</span>
						)}
					</SelectValue>
				</SelectTrigger>
				<SelectContent
					className={clsx("z-[502]", compact ? "w-[220px]" : "max-w-[280px]")}
				>
					{options.map(([value, option]) => {
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
