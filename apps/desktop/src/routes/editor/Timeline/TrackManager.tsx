import { Popover } from "@kobalte/core/popover";
import { cx } from "cva";
import { createSignal, For, type JSX, Show } from "solid-js";
import type { TimelineTrackType } from "../context";
import { CAP_TRACK_FILL_CLASS } from "./Track";

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
			style={{
				"--accent": accent(),
				"--accent-soft": `color-mix(in srgb, ${accent()} 18%, transparent)`,
			}}
			class={cx(
				"group/row flex items-center gap-3 rounded-xl p-2 text-left outline-hidden transition-colors duration-150",
				available()
					? "cursor-default hover:bg-gray-3 focus-visible:bg-gray-3"
					: "cursor-not-allowed opacity-55",
			)}
		>
			<span
				class="flex justify-center items-center rounded-[0.625rem] size-9 shrink-0 text-white transition-shadow duration-150"
				style={{
					background: available() ? accent() : "var(--gray-3)",
					color: available() ? "white" : "var(--gray-10)",
				}}
			>
				{props.option.icon()}
			</span>

			<span class="flex flex-col flex-1 min-w-0">
				<span class="flex gap-1.5 items-center text-[0.8125rem] font-medium leading-tight text-gray-12">
					<span class="truncate">{props.option.label}</span>
					<Show when={!isToggle() && (props.option.count ?? 0) > 0}>
						<span
							class="rounded-full min-w-4 px-1.5 py-px text-center text-[0.625rem] font-semibold leading-none text-white tabular-nums"
							style={{ background: accent() }}
						>
							{props.option.count}
						</span>
					</Show>
				</span>
				<span class="text-[0.6875rem] leading-snug text-gray-10 line-clamp-2">
					{description()}
				</span>
			</span>

			<Show
				when={isToggle() && isOn()}
				fallback={
					<span
						class={cx(
							"flex justify-center items-center rounded-full border size-6 shrink-0 transition-colors duration-150",
							available()
								? "border-gray-5 text-gray-10 group-hover/row:border-[var(--accent)] group-hover/row:bg-[var(--accent-soft)] group-hover/row:text-[var(--accent)]"
								: "border-gray-4 text-gray-9",
						)}
					>
						<IconLucidePlus class="size-3.5" />
					</span>
				}
			>
				<span
					class="flex justify-center items-center text-white rounded-full size-6 shrink-0"
					style={{ background: accent() }}
				>
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
					"group flex relative z-30 gap-1 items-center justify-center px-2 h-8 w-full min-w-0 text-[0.6875rem] font-medium text-white rounded-lg outline-hidden",
					"bg-linear-to-b from-[#3b82f6] to-[#2563eb]",
					"shadow-[0_2px_8px_-4px_rgba(37,99,235,0.55),inset_0_1px_0_0_rgba(255,255,255,0.2)]",
					"transition-[box-shadow,filter] duration-200 ease-out",
					"hover:brightness-[1.06]",
					"active:brightness-95",
				)}
				onMouseDown={(e) => e.stopPropagation()}
			>
				<IconLucidePlus class="size-3.5 shrink-0" />
				<span class="truncate">Add track</span>
				<IconCapChevronDown class="size-2.5 shrink-0 text-white/70 transition-transform duration-200 group-data-expanded:rotate-180" />
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					onMouseDown={(e) => e.stopPropagation()}
					// Selecting a track hands focus to the new element (e.g. the
					// inline text editor on the canvas); returning focus to the
					// trigger on close would steal it back.
					onCloseAutoFocus={(e) => e.preventDefault()}
					class={cx(
						"z-50 flex w-[min(21rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-gray-3 bg-gray-1 shadow-[0_24px_48px_-20px_rgba(0,0,0,0.55)] outline-hidden",
						"origin-[var(--kb-popover-content-transform-origin)] data-expanded:animate-in data-expanded:fade-in data-expanded:zoom-in-95 data-closed:animate-out data-closed:fade-out data-closed:zoom-out-95",
					)}
				>
					<div class="flex flex-col gap-0.5 px-4 pt-3.5 pb-3 border-b shrink-0 border-gray-3">
						<span class="text-[0.8125rem] font-semibold text-gray-12">
							Add a track
						</span>
						<span class="text-[0.6875rem] leading-snug text-gray-10">
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
					<div class="p-1.5 border-t shrink-0 border-gray-3">
						<Popover.CloseButton class="flex gap-1.5 justify-center items-center px-3 w-full h-9 text-[0.8125rem] font-medium rounded-lg border transition-colors duration-150 outline-hidden border-gray-4/70 bg-gray-2 text-gray-12 hover:bg-gray-3 hover:border-gray-5">
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
	label?: string;
	type?: TimelineTrackType;
	class?: string;
}) {
	if (!props.type) {
		return (
			<div
				class={cx(
					"relative z-10 w-full h-13 flex flex-col items-center justify-center gap-0.5 rounded-xl border shadow-[0_4px_16px_-12px_rgba(0,0,0,0.8)]",
					"border-gray-4/70 bg-gray-2/60 text-gray-12 dark:border-gray-4/60 dark:bg-gray-3/40",
					props.class,
				)}
				onMouseDown={(e) => e.stopPropagation()}
			>
				{props.icon}
				<Show when={props.label}>
					<span class="text-[0.625rem] leading-none font-medium">
						{props.label}
					</span>
				</Show>
			</div>
		);
	}

	return (
		<div
			class={cx(
				CAP_TRACK_FILL_CLASS,
				"relative z-10 w-full h-13 flex flex-col items-center justify-center gap-0.5 rounded-xl shadow-[0_4px_16px_-12px_rgba(0,0,0,0.8)] text-white",
				props.class,
			)}
			style={{ "--seg-color": trackColor(props.type) }}
			onMouseDown={(e) => e.stopPropagation()}
		>
			{props.icon}
			<Show when={props.label}>
				<span class="text-[0.625rem] leading-none font-medium">
					{props.label}
				</span>
			</Show>
		</div>
	);
}
