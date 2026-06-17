import {
	NO_MICROPHONE,
	NO_MICROPHONE_VALUE,
} from "@cap/recorder-core/recorder-constants";
import clsx from "clsx";
import { MicIcon, MicOffIcon } from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useRef } from "react";
import type { MicrophoneDevice } from "../../shared/types";
import { DEFAULT_MICROPHONE_DEVICE_ID } from "../../shared/types";
import {
	type DeviceSelectOption,
	DeviceSelectOverlay,
} from "./device-select-overlay";
import { useMediaPermission } from "./use-media-permission";

interface MicrophoneSelectorProps {
	selectedMicId: string | null;
	availableMics: MicrophoneDevice[];
	permissionGranted: boolean;
	disabled?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	onMicChange: (micId: string | null) => void;
	onRefreshDevices: () => Promise<void> | void;
	onPermissionBlocked: () => void;
}

export const MicrophoneSelector = ({
	selectedMicId,
	availableMics,
	permissionGranted,
	disabled = false,
	open = false,
	onOpenChange,
	onMicChange,
	onRefreshDevices,
	onPermissionBlocked,
}: MicrophoneSelectorProps) => {
	const micEnabled = selectedMicId !== null;
	const triggerRef = useRef<HTMLButtonElement>(null);
	const { state: permissionState, requestPermission } =
		useMediaPermission("microphone");

	const permissionSupported = permissionState !== "unsupported";
	const hasDeviceAccess = availableMics.length > 0;
	const hasAccess = permissionGranted || hasDeviceAccess || micEnabled;
	const shouldRequestPermission =
		permissionSupported && permissionState !== "granted" && !hasAccess;

	const statusPillDisabled =
		disabled || (!shouldRequestPermission && !micEnabled);

	const currentValue = selectedMicId ?? NO_MICROPHONE_VALUE;

	const options: DeviceSelectOption[] = [
		{ value: NO_MICROPHONE_VALUE, label: NO_MICROPHONE, icon: MicOffIcon },
	];
	if (
		availableMics.length === 0 ||
		selectedMicId === DEFAULT_MICROPHONE_DEVICE_ID
	) {
		options.push({
			value: DEFAULT_MICROPHONE_DEVICE_ID,
			label: "Default microphone",
			icon: MicIcon,
		});
	}
	availableMics.forEach((mic, index) => {
		options.push({
			value: mic.deviceId,
			label: mic.label?.trim() || `Microphone ${index + 1}`,
			icon: MicIcon,
		});
	});

	const selectedOption =
		options.find((option) => option.value === currentValue) ?? options[0];
	const TriggerIcon = selectedOption.icon;

	const statusPillClassName = clsx(
		"px-[0.375rem] h-[1.25rem] min-w-[2.5rem] rounded-full text-[0.75rem] leading-[1.25rem] flex items-center justify-center font-normal transition-colors duration-200 disabled:opacity-100 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:ring-[var(--blue-8)]",
		statusPillDisabled ? "cursor-default" : "cursor-pointer",
		shouldRequestPermission
			? "bg-[var(--red-3)] text-[var(--red-11)]"
			: micEnabled
				? "bg-[var(--blue-3)] text-[var(--blue-11)] hover:bg-[var(--blue-4)]"
				: "bg-[var(--red-3)] text-[var(--red-11)]",
	);

	const openPicker = () => {
		if (disabled || shouldRequestPermission) return;
		onOpenChange?.(true);
	};

	const closePicker = () => {
		onOpenChange?.(false);
		triggerRef.current?.focus();
	};

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
				onPermissionBlocked();
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
			void handleStatusPillClick(event);
		}
	};

	return (
		<div className="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
			<div className="relative w-full">
				<button
					ref={triggerRef}
					type="button"
					disabled={disabled}
					aria-haspopup="dialog"
					aria-expanded={open}
					onClick={openPicker}
					className={clsx(
						"relative flex flex-row items-center h-[2rem] pl-[0.375rem] pr-[3.5rem] gap-[0.375rem] border border-gray-3 rounded-lg w-full transition-colors overflow-hidden z-10 font-normal text-[0.875rem] bg-transparent hover:bg-transparent text-[--text-primary] disabled:text-gray-11",
						disabled || shouldRequestPermission
							? "cursor-default"
							: "cursor-pointer",
					)}
				>
					<span className="flex-1 flex items-center gap-[0.375rem] truncate">
						<TriggerIcon className="size-4 shrink-0 text-gray-11" aria-hidden />
						<span className="truncate">{selectedOption.label}</span>
					</span>
				</button>
				<button
					type="button"
					className={clsx(
						statusPillClassName,
						"absolute right-[0.375rem] top-1/2 -translate-y-1/2 z-20",
					)}
					disabled={statusPillDisabled}
					aria-disabled={statusPillDisabled}
					onClick={(event) => void handleStatusPillClick(event)}
					onKeyDown={handleStatusPillKeyDown}
				>
					{shouldRequestPermission
						? "Request permission"
						: micEnabled
							? "On"
							: "Off"}
				</button>
			</div>
			{open && (
				<DeviceSelectOverlay
					title="Select microphone"
					options={options}
					selectedValue={currentValue}
					onSelect={(value) => {
						onMicChange(value === NO_MICROPHONE_VALUE ? null : value);
						closePicker();
					}}
					onClose={closePicker}
				/>
			)}
		</div>
	);
};
