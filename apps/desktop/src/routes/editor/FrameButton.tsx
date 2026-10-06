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
import { EditorStyleContext, useEditorContext } from "./context";
import { StyleGroupToggle } from "./style-segment-config";
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
		label: "None",
		description: "Show the recording as-is",
		icon: IconLucideBan,
	},
	{
		value: "macOS",
		label: "macOS",
		description: "Window chrome with traffic lights",
		icon: IconLucideAppWindowMac,
	},
	{
		value: "windows",
		label: "Windows",
		description: "Title bar with window controls",
		icon: IconLucideAppWindow,
	},
	{
		value: "browser",
		label: "Browser",
		description: "Browser chrome with address bar",
		icon: IconLucideGlobe,
	},
	{
		value: "macbook",
		label: "MacBook",
		description: "Laptop bezel around the recording",
		icon: IconLucideLaptop,
	},
];

const THEME_TAB_TRIGGER_CLASS =
	"z-10 flex-1 h-full text-xs text-ed-text-2 transition-colors duration-100 outline-hidden data-selected:text-ed-text-1 peer";

function SettingRow(props: { name: string; children: JSX.Element }) {
	return (
		<div class="flex gap-3 justify-between items-center">
			<span class="text-xs font-medium text-ed-text-2">{props.name}</span>
			{props.children}
		</div>
	);
}

function FrameSettings() {
	const { project, setProject, selectedStyle } = useEditorContext();

	const style = () => project.background.frame?.style ?? "none";
	const updateFrame = (patch: Partial<FrameConfiguration>) =>
		setProject("background", "frame", {
			...(project.background.frame ?? DEFAULT_FRAME_CONFIG),
			...patch,
		});

	return (
		<>
			<div class="flex flex-col gap-0.5 px-4 pt-3.5 pb-3 border-b shrink-0 border-ed-line">
				<span class="text-[13px] font-semibold text-ed-text-1">Frame</span>
				<span class="text-[0.6875rem] leading-snug text-ed-text-3">
					Wrap your recording in a window or device frame.
				</span>
			</div>
			<Show when={selectedStyle()}>
				<div class="px-4 pb-3">
					<StyleGroupToggle group="background" />
				</div>
			</Show>
			<Show
				when={!selectedStyle() || selectedStyle()?.overrides.background != null}
			>
				<div class="flex flex-col gap-0.5 p-1.5">
					<For each={FRAME_STYLES}>
						{(option) => {
							const selected = () => style() === option.value;
							return (
								<button
									type="button"
									onClick={() => updateFrame({ style: option.value })}
									class="flex items-center gap-3 rounded-xl p-2 text-left outline-hidden transition-colors duration-150 hover:bg-ed-ctl-hover focus-visible:bg-ed-ctl-hover"
								>
									<span
										class={cx(
											"flex justify-center items-center rounded-[0.625rem] size-8 shrink-0 transition-colors duration-150",
											selected()
												? "bg-ed-accent text-white"
												: "bg-ed-ctl text-ed-text-2",
										)}
									>
										<Dynamic component={option.icon} class="size-4" />
									</span>
									<span class="flex flex-col flex-1 min-w-0">
										<span class="text-[13px] font-medium leading-tight text-ed-text-1">
											{option.label}
										</span>
										<span class="text-[0.6875rem] leading-snug text-ed-text-3">
											{option.description}
										</span>
									</span>
									<Show when={selected()}>
										<IconCapCircleCheck class="size-4 shrink-0 text-ed-accent" />
									</Show>
								</button>
							);
						}}
					</For>
				</div>
				<Show when={style() !== "none" && project.background.frame}>
					{(frame) => (
						<div class="flex flex-col gap-3 p-3 border-t border-ed-line">
							<SettingRow name="Theme">
								<KTabs
									class="w-40"
									value={frame().theme}
									onChange={(v) =>
										updateFrame({ theme: v as FrameConfiguration["theme"] })
									}
								>
									<KTabs.List class="flex relative flex-row gap-0.5 items-center p-0.5 h-8 rounded-lg bg-ed-ctl">
										<KTabs.Trigger
											value="light"
											class={THEME_TAB_TRIGGER_CLASS}
										>
											Light
										</KTabs.Trigger>
										<KTabs.Trigger value="dark" class={THEME_TAB_TRIGGER_CLASS}>
											Dark
										</KTabs.Trigger>
										<KTabs.Indicator class="overflow-hidden absolute inset-0 rounded-lg transition-transform flex p-0.5 peer-focus-visible:outline-solid outline-2 outline-ed-accent outline-offset-2">
											<div class="flex-1 rounded-md bg-ed-card shadow-[0_1px_2px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.06)] dark:bg-white/12 dark:shadow-none" />
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
											onInput={(e) =>
												updateFrame({ url: e.currentTarget.value })
											}
										/>
									</div>
								</SettingRow>
							</Show>
							<Show when={frame().style === "macOS"}>
								<SettingRow name="Title">
									<div class="w-40">
										<Input
											value={frame().title}
											placeholder="Window title"
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
			</Show>
		</>
	);
}

export function FrameButton() {
	const context = useEditorContext();
	return (
		<Show when={context.styleScopeToken()} keyed>
			{(_scope) => (
				<EditorStyleContext.Provider
					value={{
						...context,
						project: context.styleProject,
						setProject: context.createStyleProjectSetter(),
					}}
				>
					<ScopedFrameButton />
				</EditorStyleContext.Provider>
			)}
		</Show>
	);
}

function ScopedFrameButton() {
	const { project } = useEditorContext();

	const activeStyle = () =>
		FRAME_STYLES.find(
			(s) => s.value === (project.background.frame?.style ?? "none"),
		) ?? FRAME_STYLES[0];
	const hasFrame = () => activeStyle().value !== "none";

	return (
		<KPopover placement="bottom-start" gutter={8} flip fitViewport>
			<EditorButton<typeof KPopover.Trigger>
				as={KPopover.Trigger}
				variant="text"
				tooltipText="Add a frame"
				leftIcon={
					<Dynamic
						component={hasFrame() ? activeStyle().icon : IconLucideAppWindowMac}
					/>
				}
				rightIcon={<IconCapChevronDown />}
			>
				<span class="max-[1200px]:hidden">
					{hasFrame() ? activeStyle().label : "Frame"}
				</span>
			</EditorButton>
			<KPopover.Portal>
				<KPopover.Content
					class={cx(
						"z-60 flex w-[min(19rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl bg-ed-card shadow-ed-pop outline-hidden",
						"origin-[var(--kb-popover-content-transform-origin)] data-expanded:animate-in data-expanded:fade-in data-expanded:zoom-in-95 data-closed:animate-out data-closed:fade-out data-closed:zoom-out-95",
					)}
				>
					<FrameSettings />
				</KPopover.Content>
			</KPopover.Portal>
		</KPopover>
	);
}
