import { Popover } from "@kobalte/core/popover";
import { cx } from "cva";
import { createSignal, For, type JSX, Show } from "solid-js";
import IconLucideGripVertical from "~icons/lucide/grip-vertical";
import type { TimelineTrackType } from "../context";

type TrackManagerOption = {
	type: TimelineTrackType;
	label: string;
	icon: () => JSX.Element;
	active: boolean;
	available: boolean;
	locked: boolean;
	supportsMultiple?: boolean;
	count?: number;
};

type TrackMeta = {
	description: string;
	unavailableHint: string;
};

const TRACK_META: Record<TimelineTrackType, TrackMeta> = {
	style: {
		description: "Change background, camera and cursor for part of your video.",
		unavailableHint: "",
	},
	image: {
		description: "Place images and logos on your video.",
		unavailableHint: "",
	},
	clip: {
		description: "Your recorded screen footage.",
		unavailableHint: "",
	},
	zoom: {
		description: "Smooth zoom-ins that follow the action.",
		unavailableHint: "",
	},
	caption: {
		description: "Auto-transcribe your recording into on-screen subtitles.",
		unavailableHint: "",
	},
	keyboard: {
		description: "Display key presses on screen as you type.",
		unavailableHint: "",
	},
	text: {
		description: "Add custom text overlays and titles to the canvas.",
		unavailableHint: "",
	},
	mask: {
		description: "Blur or black out private areas of the screen.",
		unavailableHint: "",
	},
	audio: {
		description: "Add background music or import your own audio.",
		unavailableHint: "",
	},
	scene: {
		description: "Switch layouts between your screen and camera.",
		unavailableHint: "Record with a camera to use scenes.",
	},
	"3d": {
		description: "Tilt the scene in 3D perspective.",
		unavailableHint: "",
	},
};

// Comes straight from the shared `--track-*` CSS variable defined in theme.css,
// so the picker swatch is the exact same colour as the timeline segment.
const trackColor = (type: TimelineTrackType) => `var(--track-${type})`;

function TrackOptionRow(props: {
	option: TrackManagerOption;
	onSelect: () => void;
}) {
	const meta = () => TRACK_META[props.option.type];
	const accent = () => trackColor(props.option.type);
	const available = () => props.option.available;
	const isToggle = () => !props.option.supportsMultiple;
	const isOn = () => props.option.active;
	const description = () =>
		available() ? meta().description : meta().unavailableHint;

	return (
		<button
			type="button"
			disabled={!available()}
			onMouseDown={(e) => e.stopPropagation()}
			onClick={(e) => {
				e.stopPropagation();
				if (!available()) return;
				props.onSelect();
			}}
			style={{ "--seg-color": accent() }}
			class={cx(
				"group/row flex items-center gap-2.5 rounded-lg p-2 text-left outline-hidden transition-colors duration-150",
				available()
					? "cursor-default hover:bg-ed-ctl focus-visible:bg-ed-ctl"
					: "cursor-not-allowed opacity-55",
			)}
		>
			<span
				class={cx(
					"flex justify-center items-center rounded-md size-[22px] shrink-0",
					available() ? "cap-track-tile" : "bg-ed-ctl text-ed-text-3",
				)}
			>
				{props.option.icon()}
			</span>

			<span class="flex flex-col flex-1 gap-0.5 min-w-0">
				<span class="flex gap-1.5 items-center text-[13px] font-medium leading-none text-ed-text-1">
					<span class="truncate">{props.option.label}</span>
					<Show when={!isToggle() && (props.option.count ?? 0) > 0}>
						<span class="cap-track-tile rounded-full min-w-4 px-1.5 py-px text-center text-[10px] font-semibold leading-none tabular-nums">
							{props.option.count}
						</span>
					</Show>
				</span>
				<span class="text-[12px] leading-snug text-ed-text-2 line-clamp-2">
					{description()}
				</span>
			</span>

			<Show
				when={isToggle() && isOn()}
				fallback={
					<span
						class={cx(
							"flex justify-center items-center rounded-md size-5 shrink-0 transition-colors duration-150",
							available()
								? "text-ed-text-3 group-hover/row:bg-ed-ctl-hover group-hover/row:text-ed-text-1"
								: "text-ed-text-3",
						)}
					>
						<IconLucidePlus class="size-3.5" />
					</span>
				}
			>
				<span class="flex justify-center items-center rounded-md size-5 shrink-0 text-ed-accent group-hover/row:bg-ed-ctl-hover">
					<IconLucideCheck class="size-3.5 group-hover/row:hidden" />
					<IconLucideX class="hidden size-3.5 group-hover/row:block" />
				</span>
			</Show>
		</button>
	);
}

export function TrackManager(props: {
	options: TrackManagerOption[];
	onToggle(type: TimelineTrackType, next: boolean): void;
	onAdd(type: TimelineTrackType): void;
}) {
	const selectable = () => props.options.filter((option) => !option.locked);
	const [open, setOpen] = createSignal(false);

	// The timeline sits at the bottom of the editor, so the popover always flips
	// upward; the large overflowPadding keeps its top edge clear of the 56px
	// traffic-light titlebar, and fitViewport caps its height so the list scrolls
	// instead of being clipped when the window is short.
	return (
		<Popover
			placement="bottom-start"
			gutter={8}
			overflowPadding={64}
			fitViewport
			open={open()}
			onOpenChange={setOpen}
		>
			<Popover.Trigger
				class={cx(
					"flex relative z-30 shrink-0 gap-[5px] items-center pl-1.5 pr-2 h-6 rounded-md outline-hidden",
					"bg-ed-ctl text-[12px] font-medium text-ed-text-2",
					"transition-colors duration-150 hover:bg-ed-ctl-hover hover:text-ed-text-1",
				)}
				onMouseDown={(e) => e.stopPropagation()}
			>
				<IconLucidePlus class="size-3 shrink-0" />
				<span class="whitespace-nowrap">Add track</span>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					onMouseDown={(e) => e.stopPropagation()}
					// Selecting a track hands focus to the new element (e.g. the
					// inline text editor on the canvas); returning focus to the
					// trigger on close would steal it back.
					onCloseAutoFocus={(e) => e.preventDefault()}
					class={cx(
						"z-50 flex w-[min(21rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl bg-ed-card shadow-ed-pop outline-hidden",
						"origin-[var(--kb-popover-content-transform-origin)] data-expanded:animate-in data-expanded:fade-in data-expanded:zoom-in-95 data-closed:animate-out data-closed:fade-out data-closed:zoom-out-95",
					)}
				>
					<div class="flex flex-col gap-1 px-3.5 pt-3 pb-2.5 border-b shrink-0 border-ed-line">
						<span class="text-[13px] font-semibold leading-none tracking-[-0.01em] text-ed-text-1">
							Add a track
						</span>
						<span class="text-[12px] leading-snug text-ed-text-2">
							Layer captions, audio, zooms and more onto your timeline.
						</span>
					</div>
					<div class="flex overflow-y-auto flex-col flex-1 gap-0.5 p-1.5 min-h-0 scrollbar-none">
						<For each={selectable()}>
							{(option) => (
								<TrackOptionRow
									option={option}
									onSelect={() => {
										if (option.supportsMultiple) {
											props.onAdd(option.type);
										} else {
											props.onToggle(option.type, !option.active);
										}
										setOpen(false);
									}}
								/>
							)}
						</For>
					</div>
					<div class="p-1.5 border-t shrink-0 border-ed-line">
						<Popover.CloseButton class="flex gap-1.5 justify-center items-center px-3 w-full h-8 text-[13px] font-medium rounded-lg transition-colors duration-150 outline-hidden bg-ed-ctl text-ed-text-2 hover:bg-ed-ctl-hover hover:text-ed-text-1">
							<IconLucideX class="size-3.5" />
							Close
						</Popover.CloseButton>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
}

export function TrackIcon(props: {
	icon: JSX.Element;
	showGrip?: boolean;
	type?: TimelineTrackType;
	class?: string;
}) {
	return (
		<div
			class={cx(
				"pointer-events-none relative z-10 flex size-[22px] shrink-0 items-center justify-center rounded-md",
				props.type ? "cap-track-tile" : "bg-ed-ctl text-ed-text-2",
				props.class,
			)}
			style={props.type ? { "--seg-color": trackColor(props.type) } : undefined}
		>
			<Show when={props.showGrip} fallback={props.icon}>
				<span class="group-hover/icon:hidden">{props.icon}</span>
				<span class="hidden group-hover/icon:block">
					<IconLucideGripVertical class="size-3" />
				</span>
			</Show>
		</div>
	);
}
