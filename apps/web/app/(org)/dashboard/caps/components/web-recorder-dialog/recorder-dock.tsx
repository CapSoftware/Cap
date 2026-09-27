"use client";

import * as Menu from "@radix-ui/react-dropdown-menu";
import clsx from "clsx";
import {
	CheckIcon,
	ChevronDownIcon,
	LoaderCircleIcon,
	MoreHorizontalIcon,
} from "lucide-react";

// Menus portal out of the recorder, so they carry the theme class themselves.
const MENU_CONTENT =
	"cap-rec rec-pop z-[1000] min-w-[15rem] max-w-[22rem] p-1 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";
const MENU_ITEM =
	"relative flex h-8 cursor-pointer select-none items-center gap-2 rounded-md pl-8 pr-3 text-[13px] text-[var(--rec-text-1)] outline-none data-[highlighted]:bg-[var(--rec-ctl-hover)] data-[disabled]:pointer-events-none data-[disabled]:opacity-40";
const MENU_LABEL =
	"px-3 pb-1 pt-2 text-[12px] font-medium text-[var(--rec-text-2)]";

const deviceName = (device: MediaDeviceInfo, index: number, fallback: string) =>
	device.label?.trim().replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "") ||
	`${fallback} ${index + 1}`;

export const DeviceMenu = ({
	title,
	devices,
	selectedId,
	fallbackName,
	disabled = false,
	onSelect,
}: {
	title: string;
	devices: MediaDeviceInfo[];
	selectedId: string | null;
	fallbackName: string;
	disabled?: boolean;
	onSelect: (deviceId: string) => void;
}) => {
	const index = devices.findIndex((device) => device.deviceId === selectedId);
	const selected = devices[index];
	return (
		<Menu.Root modal={false}>
			<Menu.Trigger
				disabled={disabled}
				aria-label={`Choose ${title.toLowerCase()}`}
				className="rec-focus group flex h-8 min-w-0 max-w-full items-center gap-1 rounded-md px-2 text-left text-[13px] text-[var(--rec-text-1)] transition-colors hover:bg-[var(--rec-ctl-hover)] disabled:pointer-events-none data-[state=open]:bg-[var(--rec-ctl-hover)]"
			>
				<span className="truncate">
					{selected ? deviceName(selected, index, fallbackName) : fallbackName}
				</span>
				<ChevronDownIcon
					className="size-3.5 shrink-0 text-[var(--rec-text-3)] group-hover:text-[var(--rec-text-2)]"
					aria-hidden
				/>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Content
					data-recorder-menu
					side="bottom"
					align="start"
					sideOffset={6}
					collisionPadding={12}
					className={MENU_CONTENT}
				>
					<Menu.Label className={MENU_LABEL}>{title}</Menu.Label>
					<Menu.RadioGroup
						value={selectedId ?? ""}
						onValueChange={(value) => onSelect(value)}
					>
						{devices.map((device, deviceIndex) => (
							<Menu.RadioItem
								key={device.deviceId}
								value={device.deviceId}
								className={MENU_ITEM}
							>
								<Menu.ItemIndicator className="absolute left-2.5">
									<CheckIcon className="size-3.5 text-[var(--rec-accent)]" />
								</Menu.ItemIndicator>
								<span className="truncate">
									{deviceName(device, deviceIndex, fallbackName)}
								</span>
							</Menu.RadioItem>
						))}
					</Menu.RadioGroup>
				</Menu.Content>
			</Menu.Portal>
		</Menu.Root>
	);
};

export const OptionsMenu = ({
	rememberDevices,
	onRememberDevicesChange,
	disabled = false,
}: {
	rememberDevices: boolean;
	onRememberDevicesChange: (value: boolean) => void;
	disabled?: boolean;
}) => (
	<Menu.Root modal={false}>
		<Menu.Trigger
			disabled={disabled}
			aria-label="Recorder options"
			className="rec-btn is-ghost is-icon !h-7 !w-7"
		>
			<MoreHorizontalIcon className="size-4" aria-hidden />
		</Menu.Trigger>
		<Menu.Portal>
			<Menu.Content
				data-recorder-menu
				side="bottom"
				align="end"
				sideOffset={6}
				collisionPadding={12}
				className={MENU_CONTENT}
			>
				<Menu.CheckboxItem
					checked={rememberDevices}
					onCheckedChange={(checked) => onRememberDevicesChange(checked)}
					onSelect={(event) => event.preventDefault()}
					className="flex h-9 cursor-pointer select-none items-center gap-6 rounded-md px-3 text-[13px] text-[var(--rec-text-1)] outline-none data-[highlighted]:bg-[var(--rec-ctl-hover)]"
				>
					<span className="flex-1">Remember my camera and mic</span>
					<span className="rec-switch" data-on={rememberDevices} />
				</Menu.CheckboxItem>
			</Menu.Content>
		</Menu.Portal>
	</Menu.Root>
);

export const RecordButton = ({
	recording,
	busy = false,
	disabled = false,
	elapsed,
	onClick,
}: {
	recording: boolean;
	busy?: boolean;
	disabled?: boolean;
	elapsed?: string;
	onClick: () => void;
}) => (
	<button
		type="button"
		onClick={onClick}
		disabled={disabled || busy}
		className={clsx(
			"rec-record rec-focus group relative inline-flex h-12 shrink-0 items-center justify-center gap-2.5 rounded-full bg-[var(--rec-red)] pl-5 pr-6 text-[15px] font-medium text-white transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
			!recording && !busy && !disabled && "is-idle",
		)}
	>
		{busy ? (
			<LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
		) : recording ? (
			<span className="size-3 rounded-[3px] bg-white" aria-hidden />
		) : (
			<span className="size-3 rounded-full bg-white" aria-hidden />
		)}
		<span className="whitespace-nowrap">
			{busy ? "Starting" : recording ? "Stop recording" : "Start recording"}
		</span>
		{recording && elapsed && (
			<span className="-mr-1 rounded-full bg-black/15 px-2 py-0.5 text-[13px] tabular-nums">
				{elapsed}
			</span>
		)}
	</button>
);
