"use client";

import * as Menu from "@radix-ui/react-dropdown-menu";
import {
	CheckIcon,
	ChevronDownIcon,
	LoaderCircleIcon,
	MoreHorizontalIcon,
	PauseIcon,
	PlayIcon,
	RotateCcwIcon,
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
				className="rec-focus group -ml-1 flex h-5 min-w-0 max-w-full items-center gap-0.5 rounded px-1 text-left text-[12px] text-[var(--rec-text-2)] transition-colors hover:bg-[var(--rec-ctl-hover)] hover:text-[var(--rec-text-1)] disabled:pointer-events-none data-[state=open]:bg-[var(--rec-ctl-hover)]"
			>
				<span className="truncate">
					{selected ? deviceName(selected, index, fallbackName) : fallbackName}
				</span>
				<ChevronDownIcon
					className="size-3 shrink-0 text-[var(--rec-text-3)] group-hover:text-[var(--rec-text-2)]"
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

const FilmCutIcon = ({ className }: { className?: string }) => (
	<svg
		viewBox="0 0 124 119"
		fill="currentColor"
		className={className}
		aria-hidden="true"
	>
		<path d="M119.04 49.5796H48.42L115.32 31.9207C115.954 31.7539 116.548 31.4634 117.068 31.0659C117.588 30.6684 118.025 30.1718 118.352 29.6047C118.68 29.0377 118.891 28.4115 118.975 27.7621C119.06 27.1128 119.014 26.4533 118.842 25.8217L113.783 7.22689C113.087 4.72519 111.433 2.59843 109.179 1.30722C106.926 0.0160012 104.254 -0.335719 101.743 0.328232L7.32875 25.2452C6.07164 25.5715 4.89225 26.1452 3.85965 26.9328C2.82705 27.7203 1.96198 28.706 1.31509 29.8319C0.664581 30.9441 0.244302 32.1756 0.0792245 33.4533C-0.0858532 34.7311 0.00763733 36.0289 0.354142 37.2698L4.96668 54.2654C4.96668 54.3522 4.96668 54.4452 4.96668 54.5382V109.083C4.96668 111.713 6.01176 114.235 7.87202 116.095C9.73228 117.955 12.2553 119 14.8861 119H114.081C116.711 119 119.234 117.955 121.095 116.095C122.955 114.235 124 111.713 124 109.083V54.5382C124 53.2231 123.477 51.9618 122.547 51.0319C121.617 50.102 120.356 49.5796 119.04 49.5796ZM104.26 9.91073L107.98 23.5903L87.1555 29.1253L69.7159 19.0346L104.26 9.91073ZM33.2061 28.6728L50.6395 38.7388L13.6896 48.4887L9.9698 34.8029L33.2061 28.6728Z" />
	</svg>
);

// The desktop app's Start Recording pill: blue gradient, mode icon, a title
// and the mode underneath.
export const StartRecordingButton = ({
	busy = false,
	disabled = false,
	detail,
	onClick,
}: {
	busy?: boolean;
	disabled?: boolean;
	detail: string;
	onClick: () => void;
}) => (
	<button
		type="button"
		onClick={onClick}
		disabled={disabled || busy}
		className="rec-start rec-focus group flex h-11 w-[min(18rem,100%)] items-center overflow-hidden rounded-full text-left text-white transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100"
	>
		<span className="flex h-full flex-1 items-center gap-3 pl-4 pr-5 transition-colors group-hover:bg-white/10 group-disabled:bg-transparent">
			{busy ? (
				<LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
			) : (
				<FilmCutIcon className="size-4 shrink-0" />
			)}
			<span className="flex min-w-0 flex-col">
				<span className="whitespace-nowrap text-[15px] font-medium leading-tight">
					{busy ? "Starting" : "Start Recording"}
				</span>
				<span className="truncate text-[11px] font-light leading-tight text-white/90">
					{detail}
				</span>
			</span>
		</span>
	</button>
);

// The desktop app's in-progress bar: stop with the running time, then pause
// and restart.
export const RecordingBar = ({
	time,
	paused,
	restarting,
	onStop,
	onPauseToggle,
	onRestart,
}: {
	time: string;
	paused: boolean;
	restarting: boolean;
	onStop: () => void;
	onPauseToggle: () => void;
	onRestart: () => void;
}) => (
	<div
		className="rec-pop flex h-11 items-stretch gap-0.5 rounded-2xl p-1"
		style={
			paused
				? { boxShadow: "var(--rec-pop-shadow), 0 0 0 1px #f5a52480" }
				: undefined
		}
	>
		<button
			type="button"
			onClick={onStop}
			aria-label="Stop recording"
			title="Stop recording"
			className="rec-focus flex items-center gap-2 rounded-xl pl-2.5 pr-3.5 text-[var(--rec-red)] transition-colors hover:bg-[color-mix(in_srgb,var(--rec-red)_9%,transparent)]"
		>
			<StopCircle />
			<span className="text-[14px] font-medium tabular-nums">{time}</span>
			<span className="text-[13px] font-medium">Stop</span>
		</button>
		<span className="my-1.5 w-px bg-[var(--rec-line)]" />
		<button
			type="button"
			onClick={onPauseToggle}
			aria-label={paused ? "Resume recording" : "Pause recording"}
			title={paused ? "Resume" : "Pause"}
			className="rec-focus flex w-9 items-center justify-center rounded-xl text-[var(--rec-text-2)] transition-colors hover:bg-[var(--rec-ctl)] hover:text-[var(--rec-text-1)]"
		>
			{paused ? (
				<PlayIcon className="size-4" aria-hidden />
			) : (
				<PauseIcon className="size-4" aria-hidden />
			)}
		</button>
		<button
			type="button"
			onClick={onRestart}
			disabled={restarting}
			aria-label="Start over"
			title="Start over"
			className="rec-focus flex w-9 items-center justify-center rounded-xl text-[var(--rec-text-2)] transition-colors hover:bg-[var(--rec-ctl)] hover:text-[var(--rec-text-1)] disabled:opacity-40"
		>
			<RotateCcwIcon className="size-4" aria-hidden />
		</button>
	</div>
);

const StopCircle = () => (
	<svg viewBox="0 0 20 20" className="size-5 shrink-0" aria-hidden="true">
		<circle
			cx="10"
			cy="10"
			r="8.25"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
		/>
		<rect
			x="6.75"
			y="6.75"
			width="6.5"
			height="6.5"
			rx="1.25"
			fill="currentColor"
		/>
	</svg>
);
