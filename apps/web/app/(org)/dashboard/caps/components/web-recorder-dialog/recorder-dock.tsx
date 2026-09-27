"use client";

import * as Menu from "@radix-ui/react-dropdown-menu";
import clsx from "clsx";
import {
	CheckIcon,
	ChevronUpIcon,
	LoaderCircleIcon,
	type LucideIcon,
	MoreHorizontalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

const MENU_CONTENT =
	"z-[1000] min-w-[16rem] max-w-[22rem] rounded-2xl border border-white/10 bg-[#1b1c1f] p-1.5 text-white shadow-[0_24px_48px_-12px_rgba(0,0,0,0.6)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-2";
const MENU_ITEM =
	"relative flex cursor-pointer select-none items-center gap-2.5 rounded-lg py-2 pl-8 pr-3 text-[0.8125rem] text-white/80 outline-none transition-colors data-[highlighted]:bg-white/[0.08] data-[highlighted]:text-white data-[disabled]:pointer-events-none data-[disabled]:opacity-40";
const MENU_TOGGLE =
	"flex cursor-pointer select-none items-center gap-4 rounded-lg px-3 py-2.5 text-[0.8125rem] text-white/85 outline-none transition-colors data-[highlighted]:bg-white/[0.06] data-[highlighted]:text-white";
const MENU_LABEL = "px-3 pb-1.5 pt-2 text-[0.75rem] font-medium text-white/45";

export const DockButton = ({
	icon: Icon,
	label,
	on,
	onClick,
	disabled = false,
	menu,
	badge,
}: {
	icon: LucideIcon;
	label: string;
	on: boolean;
	onClick: () => void;
	disabled?: boolean;
	menu?: ReactNode;
	badge?: ReactNode;
}) => (
	<div className="flex items-center">
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="group flex w-[4.5rem] flex-col items-center gap-1.5 rounded-xl py-1.5 text-white/80 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4785FF] disabled:cursor-not-allowed disabled:opacity-40 sm:w-[5.25rem]"
		>
			<span
				className={clsx(
					"relative flex size-11 items-center justify-center rounded-full transition-colors",
					on
						? "bg-white/[0.08] group-hover:bg-white/[0.14]"
						: "bg-[#ff4d4f]/15 text-[#ff8587] group-hover:bg-[#ff4d4f]/25",
				)}
			>
				<Icon className="size-5" aria-hidden />
				{badge && (
					<span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2">
						{badge}
					</span>
				)}
			</span>
			<span className="whitespace-nowrap text-[0.75rem] font-medium leading-none">
				{label}
			</span>
		</button>
		{menu}
	</div>
);

export const DeviceMenu = ({
	title,
	devices,
	selectedId,
	fallbackName,
	offLabel,
	disabled = false,
	onSelect,
}: {
	title: string;
	devices: MediaDeviceInfo[];
	selectedId: string | null;
	fallbackName: string;
	offLabel: string;
	disabled?: boolean;
	onSelect: (deviceId: string | null) => void;
}) => (
	<Menu.Root modal={false}>
		<Menu.Trigger
			disabled={disabled}
			aria-label={`Choose ${title.toLowerCase()}`}
			className="-ml-2 mb-6 flex h-7 w-6 items-center justify-center rounded-md text-white/50 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4785FF] disabled:pointer-events-none disabled:opacity-30 data-[state=open]:bg-white/10 data-[state=open]:text-white"
		>
			<ChevronUpIcon className="size-3.5" aria-hidden />
		</Menu.Trigger>
		<Menu.Portal>
			<Menu.Content
				data-recorder-menu
				side="top"
				align="center"
				sideOffset={14}
				collisionPadding={12}
				className={MENU_CONTENT}
			>
				<Menu.Label className={MENU_LABEL}>{title}</Menu.Label>
				<Menu.RadioGroup
					value={selectedId ?? ""}
					onValueChange={(value) => onSelect(value || null)}
				>
					{devices.map((device, index) => (
						<Menu.RadioItem
							key={device.deviceId}
							value={device.deviceId}
							className={MENU_ITEM}
						>
							<Menu.ItemIndicator className="absolute left-2.5">
								<CheckIcon className="size-3.5 text-[#4785FF]" />
							</Menu.ItemIndicator>
							<span className="truncate">
								{device.label?.trim() || `${fallbackName} ${index + 1}`}
							</span>
						</Menu.RadioItem>
					))}
					<Menu.Separator className="my-1 h-px bg-white/[0.08]" />
					<Menu.RadioItem value="" className={MENU_ITEM}>
						<Menu.ItemIndicator className="absolute left-2.5">
							<CheckIcon className="size-3.5 text-[#4785FF]" />
						</Menu.ItemIndicator>
						{offLabel}
					</Menu.RadioItem>
				</Menu.RadioGroup>
			</Menu.Content>
		</Menu.Portal>
	</Menu.Root>
);

const MenuSwitch = ({ on }: { on: boolean }) => (
	<span
		aria-hidden
		className={clsx(
			"relative h-5 w-9 shrink-0 rounded-full transition-colors",
			on ? "bg-[#4785FF]" : "bg-white/15",
		)}
	>
		<span
			className={clsx(
				"absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]",
				on ? "left-[1.125rem]" : "left-0.5",
			)}
		/>
	</span>
);

export const MoreMenu = ({
	systemAudio,
	rememberDevices,
	onRememberDevicesChange,
	disabled = false,
}: {
	systemAudio: {
		enabled: boolean;
		hint: string | null;
		onChange: (enabled: boolean) => void;
	} | null;
	rememberDevices: boolean;
	onRememberDevicesChange: (value: boolean) => void;
	disabled?: boolean;
}) => (
	<Menu.Root modal={false}>
		<Menu.Trigger
			disabled={disabled}
			className="group flex w-[4.5rem] flex-col items-center gap-1.5 rounded-xl py-1.5 text-white/80 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4785FF] disabled:cursor-not-allowed disabled:opacity-40 sm:w-[5.25rem]"
		>
			<span className="flex size-11 items-center justify-center rounded-full bg-white/[0.08] transition-colors group-hover:bg-white/[0.14] group-data-[state=open]:bg-white/[0.14]">
				<MoreHorizontalIcon className="size-5" aria-hidden />
			</span>
			<span className="text-[0.75rem] font-medium leading-none">More</span>
		</Menu.Trigger>
		<Menu.Portal>
			<Menu.Content
				data-recorder-menu
				side="top"
				align="end"
				sideOffset={14}
				collisionPadding={12}
				className={MENU_CONTENT}
			>
				{systemAudio && (
					<>
						<Menu.CheckboxItem
							checked={systemAudio.enabled}
							onCheckedChange={(checked) => systemAudio.onChange(checked)}
							onSelect={(event) => event.preventDefault()}
							className={MENU_TOGGLE}
						>
							<span className="flex flex-1 flex-col gap-0.5">
								<span>Record system audio</span>
								<span className="text-[0.75rem] leading-snug text-white/45">
									{systemAudio.hint ??
										"Sound from your computer, on its own track."}
								</span>
							</span>
							<MenuSwitch on={systemAudio.enabled} />
						</Menu.CheckboxItem>
						<Menu.Separator className="my-1 h-px bg-white/[0.08]" />
					</>
				)}
				<Menu.CheckboxItem
					checked={rememberDevices}
					onCheckedChange={(checked) => onRememberDevicesChange(checked)}
					onSelect={(event) => event.preventDefault()}
					className={MENU_TOGGLE}
				>
					<span className="flex-1">Remember my camera and mic</span>
					<MenuSwitch on={rememberDevices} />
				</Menu.CheckboxItem>
			</Menu.Content>
		</Menu.Portal>
	</Menu.Root>
);

export const RecordButton = ({
	recording,
	busy = false,
	disabled = false,
	label,
	onClick,
}: {
	recording: boolean;
	busy?: boolean;
	disabled?: boolean;
	label: string;
	onClick: () => void;
}) => (
	<button
		type="button"
		onClick={onClick}
		disabled={disabled || busy}
		aria-label={label}
		title={label}
		className="group relative mx-2 flex size-[4.25rem] shrink-0 items-center justify-center rounded-full border-[3px] border-white/85 transition-[border-color,transform] duration-200 hover:border-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4785FF] focus-visible:ring-offset-4 focus-visible:ring-offset-[#111214] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 sm:mx-4"
	>
		<span
			className={clsx(
				"flex items-center justify-center bg-[#ff4d4f] shadow-[0_0_24px_-4px_rgba(255,77,79,0.8)] transition-all duration-300 ease-[cubic-bezier(.2,.8,.2,1)]",
				recording
					? "size-6 rounded-[6px]"
					: "size-[3.25rem] rounded-full group-hover:size-[3.5rem]",
			)}
		>
			{busy && (
				<LoaderCircleIcon
					className="size-5 animate-spin text-white"
					aria-hidden
				/>
			)}
		</span>
	</button>
);
