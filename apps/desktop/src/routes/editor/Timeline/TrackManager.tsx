import { Popover } from "@kobalte/core/popover";
import { cx } from "cva";
import { createSignal, Index, type JSX, Show } from "solid-js";
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
		description: "为视频的某一段更换背景、摄像头和光标。",
		unavailableHint: "",
	},
	image: {
		description: "在视频中放置图片和 Logo。",
		unavailableHint: "",
	},
	clip: {
		description: "你录制的屏幕画面。",
		unavailableHint: "",
	},
	zoom: {
		description: "跟随动作的平滑缩放。",
		unavailableHint: "",
	},
	caption: {
		description: "自动将录制内容转写为屏幕字幕。",
		unavailableHint: "",
	},
	keyboard: {
		description: "打字时在屏幕上显示按键。",
		unavailableHint: "",
	},
	text: {
		description: "在画布上添加自定义文字叠加与标题。",
		unavailableHint: "",
	},
	mask: {
		description: "对屏幕上的隐私区域进行模糊或涂黑处理。",
		unavailableHint: "",
	},
	audio: {
		description: "添加背景音乐，或导入你自己的音频。",
		unavailableHint: "",
	},
	scene: {
		description: "在屏幕和摄像头之间切换布局。",
		unavailableHint: "使用摄像头录制才能使用场景。",
	},
	"3d": {
		description: "为录制添加电影感的 3D 运镜。",
		unavailableHint: "",
	},
};

const DEFAULT_HINT = "选择要添加到时间线的轨道。";

// Comes straight from the shared `--track-*` CSS variable defined in theme.css,
// so the picker swatch is the exact same colour as the timeline segment.
const trackColor = (type: TimelineTrackType) => `var(--track-${type})`;

function trackHint(option: TrackManagerOption) {
	const meta = TRACK_META[option.type];
	if (!option.available) return meta.unavailableHint;
	if (!option.supportsMultiple && option.active)
		return `Remove the ${option.label} track.`;
	return meta.description;
}

function TrackTile(props: {
	option: TrackManagerOption;
	index: number;
	onSelect: () => void;
	onHover: (type: TimelineTrackType | null) => void;
}) {
	const available = () => props.option.available;
	const isOn = () => !props.option.supportsMultiple && props.option.active;
	const count = () =>
		props.option.supportsMultiple ? (props.option.count ?? 0) : 0;

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
			onMouseEnter={() => props.onHover(props.option.type)}
			onMouseLeave={() => props.onHover(null)}
			onFocus={() => props.onHover(props.option.type)}
			onBlur={() => props.onHover(null)}
			style={{
				"--seg-color": trackColor(props.option.type),
				"--tray-index": props.index,
			}}
			class={cx(
				"cap-track-tray-tile group/tile flex w-16 shrink-0 flex-col items-center gap-1.5 rounded-lg pt-2 pb-1.5 outline-hidden transition-[background-color,transform] duration-150",
				available()
					? "cursor-default hover:bg-ed-ctl focus-visible:bg-ed-ctl active:scale-95"
					: "cursor-not-allowed opacity-45",
			)}
		>
			<span class="relative">
				<span
					class={cx(
						"flex size-7 items-center justify-center rounded-lg [&>svg]:size-3.5",
						available() ? "cap-track-tile" : "bg-ed-ctl text-ed-text-3",
					)}
				>
					{props.option.icon()}
				</span>
				<Show when={isOn()}>
					<span class="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-ed-accent text-white ring-2 ring-ed-card">
						<IconLucideCheck class="size-2" />
					</span>
				</Show>
				<Show when={count() > 0}>
					<span class="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-ed-text-1 px-1 text-[9px] font-semibold leading-none tabular-nums text-ed-card ring-2 ring-ed-card">
						{count()}
					</span>
				</Show>
			</span>
			<span
				class={cx(
					"whitespace-nowrap text-[11px] font-medium leading-none transition-colors duration-150",
					available()
						? "text-ed-text-2 group-hover/tile:text-ed-text-1"
						: "text-ed-text-3",
				)}
			>
				{props.option.label}
			</span>
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
	const [hovered, setHovered] = createSignal<TimelineTrackType | null>(null);
	const hint = () => {
		const type = hovered();
		const option = type && props.options.find((o) => o.type === type);
		return option ? trackHint(option) : DEFAULT_HINT;
	};

	// The tray is anchored to the whole gutter box, not the pill, so it slides
	// out from the exact column where the track lanes begin and its bottom
	// edge sits on the ruler's baseline; the GPUI editor anchors the same way.
	return (
		<Popover
			placement="right-end"
			gutter={0}
			overflowPadding={12}
			open={open()}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setHovered(null);
			}}
		>
			<Popover.Anchor class="flex size-full items-center">
				<Popover.Trigger
					class={cx(
						"group/trigger relative z-30 flex h-6 shrink-0 items-center gap-[5px] rounded-md pl-1.5 pr-2 outline-hidden",
						"bg-ed-text-1 text-[12px] font-medium text-ed-card",
						"transition-[opacity,transform] duration-150 hover:opacity-85 active:scale-[0.97]",
					)}
					onMouseDown={(e) => e.stopPropagation()}
				>
					<IconLucidePlus class="size-3 shrink-0 transition-transform duration-200 ease-out group-data-[expanded]/trigger:rotate-45" />
					<span class="whitespace-nowrap">添加轨道</span>
				</Popover.Trigger>
			</Popover.Anchor>
			<Popover.Portal>
				<Popover.Content
					onMouseDown={(e) => e.stopPropagation()}
					// Selecting a track hands focus to the new element (e.g. the
					// inline text editor on the canvas); returning focus to the
					// trigger on close would steal it back.
					onCloseAutoFocus={(e) => e.preventDefault()}
					class="cap-track-tray z-50 flex origin-[var(--kb-popover-content-transform-origin)] flex-col overflow-hidden rounded-xl bg-ed-card shadow-ed-pop outline-hidden"
				>
					<div class="flex gap-1 p-1.5">
						<Index each={selectable()}>
							{(option, index) => (
								<TrackTile
									option={option()}
									index={index}
									onHover={setHovered}
									onSelect={() => {
										const current = option();
										if (current.supportsMultiple) {
											props.onAdd(current.type);
										} else {
											props.onToggle(current.type, !current.active);
										}
										setOpen(false);
									}}
								/>
							)}
						</Index>
					</div>
					<div class="flex h-[30px] items-center border-t border-ed-line px-3 text-[11px] leading-none text-ed-text-2">
						<span class="truncate">{hint()}</span>
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
