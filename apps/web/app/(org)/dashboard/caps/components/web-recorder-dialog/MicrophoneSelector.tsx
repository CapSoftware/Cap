"use client";

import {
	SelectContent,
	SelectItem,
	SelectRoot,
	SelectTrigger,
	SelectValue,
} from "@cap/ui";
import clsx from "clsx";
import { MicIcon, MicOffIcon } from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";
import { toast } from "sonner";
import { useMediaPermission } from "./useMediaPermission";
import { NO_MICROPHONE, NO_MICROPHONE_VALUE } from "./web-recorder-constants";

interface MicrophoneSelectorProps {
	selectedMicId: string | null;
	availableMics: MediaDeviceInfo[];
	dialogOpen: boolean;
	disabled?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	onMicChange: (micId: string | null) => void;
	onRefreshDevices: () => Promise<void> | void;
}

export const MicrophoneSelector = ({
	selectedMicId,
	availableMics,
	dialogOpen,
	disabled = false,
	open,
	onOpenChange,
	onMicChange,
	onRefreshDevices,
}: MicrophoneSelectorProps) => {
	const micEnabled = selectedMicId !== null;
	const { state: permissionState, requestPermission } = useMediaPermission(
		"microphone",
		dialogOpen,
	);

	const permissionSupported = permissionState !== "unsupported";
	const shouldRequestPermission =
		permissionSupported && permissionState !== "granted";

	const statusPillDisabled =
		disabled || (!shouldRequestPermission && !micEnabled);

	const statusPillClassName = clsx(
		"px-[0.375rem] h-[1.25rem] min-w-[2.5rem] rounded-full text-[0.75rem] leading-[1.25rem] flex items-center justify-center font-normal transition-colors duration-200 disabled:opacity-100 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:ring-[var(--blue-8)]",
		statusPillDisabled ? "cursor-default" : "cursor-pointer",
		shouldRequestPermission
			? "bg-[var(--red-3)] text-[var(--red-11)] dark:bg-[var(--red-4)] dark:text-[var(--red-12)]"
			: micEnabled
				? "bg-[var(--blue-3)] text-[var(--blue-11)] dark:bg-[var(--blue-4)] dark:text-[var(--blue-12)] hover:bg-[var(--blue-4)] dark:hover:bg-[var(--blue-5)]"
				: "bg-[var(--red-3)] text-[var(--red-11)] dark:bg-[var(--red-4)] dark:text-[var(--red-12)]",
	);

	const handleStatusPillClick = async (
		event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>,
	) => {
		if (disabled) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}

		if (shouldRequestPermission) {
			event.preventDefault();
			event.stopPropagation();

			try {
				const granted = await requestPermission();
				if (granted) {
					await Promise.resolve(onRefreshDevices());
				}
			} catch (error) {
				console.error("Microphone permission request failed", error);
				toast.error(
					"Unable to access your microphone. Check browser permissions.",
				);
			}

			return;
		}

		if (!micEnabled) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();

		onMicChange(null);
	};

	const handleStatusPillKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (disabled) {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				event.stopPropagation();
			}
			return;
		}

		if (event.key === "Enter" || event.key === " ") {
			handleStatusPillClick(event);
		}
	};

	return (
		<div className="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
			<SelectRoot
				value={selectedMicId ?? NO_MICROPHONE_VALUE}
				onValueChange={(value) => {
					onMicChange(value === NO_MICROPHONE_VALUE ? null : value);
				}}
				disabled={disabled}
				open={open}
				onOpenChange={onOpenChange}
			>
				<div className="relative w-full">
					<SelectTrigger
						className={clsx(
							"relative flex flex-row items-center h-[2rem] pl-[0.375rem] pr-[3.5rem] gap-[0.375rem] border border-gray-3 rounded-lg w-full transition-colors overflow-hidden z-10 font-normal text-[0.875rem] bg-transparent hover:bg-transparent focus:bg-transparent focus:border-gray-3 hover:border-gray-3 text-[--text-primary] disabled:text-gray-11 [&>svg]:hidden",
							disabled || shouldRequestPermission
								? "cursor-default"
								: undefined,
						)}
						onPointerDown={(event) => {
							if (shouldRequestPermission) {
								event.preventDefault();
								event.stopPropagation();
							}
						}}
						onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
							if (shouldRequestPermission) {
								const keys = ["Enter", " ", "ArrowDown", "ArrowUp"];
								if (keys.includes(event.key)) {
									event.preventDefault();
									event.stopPropagation();
								}
							}
						}}
						aria-disabled={disabled || shouldRequestPermission}
					>
						<SelectValue
							placeholder={NO_MICROPHONE}
							className="flex-1 flex items-center gap-[0.375rem] truncate"
						/>
					</SelectTrigger>
					<button
						type="button"
						className={clsx(
							statusPillClassName,
							"absolute right-[0.375rem] top-1/2 -translate-y-1/2 z-20",
						)}
						disabled={statusPillDisabled}
						aria-disabled={statusPillDisabled}
						onClick={handleStatusPillClick}
						onKeyDown={handleStatusPillKeyDown}
					>
						{shouldRequestPermission
							? "Request permission"
							: micEnabled
								? "On"
								: "Off"}
					</button>
				</div>
				<SelectContent className="z-[502]">
					<SelectItem value={NO_MICROPHONE_VALUE}>
						<span className="flex items-center gap-2 truncate">
							<MicOffIcon className="size-4 text-gray-11" />
							{NO_MICROPHONE}
						</span>
					</SelectItem>
					{availableMics.map((mic, index) => (
						<SelectItem key={mic.deviceId} value={mic.deviceId}>
							<span className="flex items-center gap-2 truncate">
								<MicIcon className="size-4 text-gray-11" />
								{mic.label?.trim() || `Microphone ${index + 1}`}
							</span>
						</SelectItem>
					))}
				</SelectContent>
			</SelectRoot>
		</div>
	);
};
