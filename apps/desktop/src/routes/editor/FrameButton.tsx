import { Popover as KPopover } from "@kobalte/core/popover";
import { Tabs as KTabs } from "@kobalte/core/tabs";
import { cx } from "cva";
import { type Component, For, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { FrameConfiguration, FrameStyle } from "~/utils/tauri";
import IconCapChevronDown from "~icons/cap/chevron-down";
import IconCapCircleCheck from "~icons/cap/circle-check";
import IconLucideAppWindow from "~icons/lucide/app-window";
import IconLucideAppWindowMac from "~icons/lucide/app-window-mac";
import IconLucideBan from "~icons/lucide/ban";
import IconLucideGlobe from "~icons/lucide/globe";
import IconLucideLaptop from "~icons/lucide/laptop";
import { useEditorContext } from "./context";
import { EditorButton, Input } from "./ui";

const DEFAULT_FRAME_CONFIG: FrameConfiguration = {
	style: "none",
	theme: "dark",
	url: "Cap.so",
	title: "",
};

const FRAME_STYLES: Array<{
	value: FrameStyle;
	label: string;
	description: string;
	icon: Component<{ class?: string }>;
}> = [
	{
		value: "none",
		label: "无",
		description: "按原样显示录制画面",
		icon: IconLucideBan,
	},
	{
		value: "macOS",
		label: "macOS",
		description: "带红黄绿控制按钮的窗口边框",
		icon: IconLucideAppWindowMac,
	},
	{
		value: "windows",
		label: "Windows 窗口",
		description: "带窗口控制按钮的标题栏",
		icon: IconLucideAppWindow,
	},
	{
		value: "browser",
		label: "浏览器",
		description: "带地址栏的浏览器边框",
		icon: IconLucideGlobe,
	},
	{
		value: "macbook",
		label: "MacBook",
		description: "在录制画面周围添加笔记本电脑边框",
		icon: IconLucideLaptop,
	},
];

const THEME_TAB_TRIGGER_CLASS =
	"z-10 flex-1 h-full text-xs text-gray-11 transition-colors duration-100 outline-hidden data-selected:text-gray-12 peer";

function SettingRow(props: { name: string; children: JSX.Element }) {
	return (
		<div class="flex gap-3 justify-between items-center">
			<span class="text-xs font-medium text-gray-11">{props.name}</span>
			{props.children}
		</div>
	);
}

function FrameSettings() {
	const { project, setProject } = useEditorContext();

	const style = () => project.background.frame?.style ?? "none";
	const updateFrame = (patch: Partial<FrameConfiguration>) =>
		setProject("background", "frame", {
			...(project.background.frame ?? DEFAULT_FRAME_CONFIG),
			...patch,
		});

	return (
		<>
			<div class="flex flex-col gap-0.5 px-4 pt-3.5 pb-3 border-b shrink-0 border-gray-3">
				<span class="text-[0.8125rem] font-semibold text-gray-12">外框</span>
				<span class="text-[0.6875rem] leading-snug text-gray-10">
					Wrap your recording in a window or device frame.
				</span>
			</div>
			<div class="flex flex-col gap-0.5 p-1.5">
				<For each={FRAME_STYLES}>
					{(option) => {
						const selected = () => style() === option.value;
						return (
							<button
								type="button"
								onClick={() => updateFrame({ style: option.value })}
								class="flex items-center gap-3 rounded-xl p-2 text-left outline-hidden transition-colors duration-150 hover:bg-gray-3 focus-visible:bg-gray-3"
							>
								<span
									class={cx(
										"flex justify-center items-center rounded-[0.625rem] size-8 shrink-0 transition-colors duration-150",
										selected()
											? "bg-blue-9 text-white"
											: "bg-gray-3 text-gray-11",
									)}
								>
									<Dynamic component={option.icon} class="size-4" />
								</span>
								<span class="flex flex-col flex-1 min-w-0">
									<span class="text-[0.8125rem] font-medium leading-tight text-gray-12">
										{option.label}
									</span>
									<span class="text-[0.6875rem] leading-snug text-gray-10">
										{option.description}
									</span>
								</span>
								<Show when={selected()}>
									<IconCapCircleCheck class="size-4 shrink-0 text-blue-9" />
								</Show>
							</button>
						);
					}}
				</For>
			</div>
			<Show when={style() !== "none" && project.background.frame}>
				{(frame) => (
					<div class="flex flex-col gap-3 p-3 border-t border-gray-3">
						<SettingRow name="主题">
							<KTabs
								class="w-40"
								value={frame().theme}
								onChange={(v) =>
									updateFrame({ theme: v as FrameConfiguration["theme"] })
								}
							>
								<KTabs.List class="flex relative flex-row items-center h-8 rounded-lg border border-gray-3">
									<KTabs.Trigger value="light" class={THEME_TAB_TRIGGER_CLASS}>
										浅色
									</KTabs.Trigger>
									<KTabs.Trigger value="dark" class={THEME_TAB_TRIGGER_CLASS}>
										深色
									</KTabs.Trigger>
									<KTabs.Indicator class="overflow-hidden absolute inset-0 rounded-lg transition-transform flex p-px peer-focus-visible:outline-solid outline-2 outline-blue-9 outline-offset-2">
										<div class="flex-1 bg-gray-3" />
									</KTabs.Indicator>
								</KTabs.List>
							</KTabs>
						</SettingRow>
						<Show when={frame().style === "browser"}>
							<SettingRow name="URL">
								<div class="w-40">
									<Input
										value={frame().url}
										placeholder="cap.so"
										onInput={(e) => updateFrame({ url: e.currentTarget.value })}
									/>
								</div>
							</SettingRow>
						</Show>
						<Show when={frame().style === "macOS"}>
							<SettingRow name="标题">
								<div class="w-40">
									<Input
										value={frame().title}
										placeholder="窗口标题"
										onInput={(e) =>
											updateFrame({ title: e.currentTarget.value })
										}
									/>
								</div>
							</SettingRow>
						</Show>
					</div>
				)}
			</Show>
		</>
	);
}

export function FrameButton() {
	const { project } = useEditorContext();

	const activeStyle = () =>
		FRAME_STYLES.find(
			(s) => s.value === (project.background.frame?.style ?? "none"),
		) ?? FRAME_STYLES[0];
	const hasFrame = () => activeStyle().value !== "none";

	return (
		<KPopover placement="bottom-start" gutter={8} fitViewport>
			<EditorButton<typeof KPopover.Trigger>
				as={KPopover.Trigger}
				tooltipText="添加外框"
				leftIcon={
					<Dynamic
						component={hasFrame() ? activeStyle().icon : IconLucideAppWindowMac}
						class="w-5 text-gray-12"
					/>
				}
				rightIcon={<IconCapChevronDown />}
			>
				{hasFrame() ? activeStyle().label : "外框"}
			</EditorButton>
			<KPopover.Portal>
				<KPopover.Content
					class={cx(
						"z-60 flex w-[min(19rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-gray-3 bg-gray-1 shadow-[0_24px_48px_-20px_rgba(0,0,0,0.55)] outline-hidden",
						"origin-[var(--kb-popover-content-transform-origin)] data-expanded:animate-in data-expanded:fade-in data-expanded:zoom-in-95 data-closed:animate-out data-closed:fade-out data-closed:zoom-out-95",
					)}
				>
					<FrameSettings />
				</KPopover.Content>
			</KPopover.Portal>
		</KPopover>
	);
}
