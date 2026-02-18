import { NumberField } from "@kobalte/core";
import {
	Collapsible,
	Collapsible as KCollapsible,
} from "@kobalte/core/collapsible";
import {
	RadioGroup as KRadioGroup,
	RadioGroup,
} from "@kobalte/core/radio-group";
import { Select as KSelect } from "@kobalte/core/select";
import { Tabs as KTabs } from "@kobalte/core/tabs";
import { createElementBounds } from "@solid-primitives/bounds";
import { createEventListenerMap } from "@solid-primitives/event-listener";
import { createWritableMemo } from "@solid-primitives/memo";
import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir, resolveResource } from "@tauri-apps/api/path";
import { BaseDirectory, writeFile } from "@tauri-apps/plugin-fs";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
	batch,
	createEffect,
	createMemo,
	createResource,
	createRoot,
	createSignal,
	For,
	Index,
	on,
	onMount,
	Show,
	Suspense,
	type ValidComponent,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Dynamic } from "solid-js/web";
import toast from "solid-toast";
import colorBg from "~/assets/illustrations/color.webp";
import gradientBg from "~/assets/illustrations/gradient.webp";
import imageBg from "~/assets/illustrations/image.webp";
import transparentBg from "~/assets/illustrations/transparent.webp";
import { Toggle } from "~/components/Toggle";
import { generalSettingsStore } from "~/store";
import {
	type BackgroundSource,
	type CameraShape,
	type ClipOffsets,
	type CursorAnimationStyle,
	type CursorType,
	commands,
	type SceneSegment,
	type StereoMode,
	type TimelineSegment,
	type ZoomSegment,
} from "~/utils/tauri";
import IconLucideBoxSelect from "~icons/lucide/box-select";
import IconLucideGauge from "~icons/lucide/gauge";
import IconLucideGrid from "~icons/lucide/grid";
import IconLucideMonitor from "~icons/lucide/monitor";
import IconLucideMoon from "~icons/lucide/moon";
import IconLucidePalette from "~icons/lucide/palette";
import IconLucideRabbit from "~icons/lucide/rabbit";
import IconLucideSparkles from "~icons/lucide/sparkles";
import IconLucideTimer from "~icons/lucide/timer";
import IconLucideType from "~icons/lucide/type";
import IconLucideWind from "~icons/lucide/wind";
import { CaptionsTab } from "./CaptionsTab";
import { KeyboardTab } from "./KeyboardTab";
import { type CornerRoundingType, useEditorContext } from "./context";
import { evaluateMask, type MaskKind, type MaskSegment } from "./masks";
import {
	DEFAULT_GRADIENT_FROM,
	DEFAULT_GRADIENT_TO,
	type RGBColor,
} from "./projectConfig";
import ShadowSettings from "./ShadowSettings";
import { TextInput } from "./TextInput";
import type { TextSegment } from "./text";
import {
	ComingSoonTooltip,
	EditorButton,
	Field,
	MenuItem,
	MenuItemList,
	PopperContent,
	Slider,
	Subfield,
	topSlideAnimateClasses,
} from "./ui";

const BACKGROUND_SOURCES = {
	wallpaper: "Wallpaper",
	image: "Image",
	color: "Color",
	gradient: "Gradient",
} satisfies Record<BackgroundSource["type"], string>;

const BACKGROUND_ICONS = {
	wallpaper: imageBg,
	image: transparentBg,
	color: colorBg,
	gradient: gradientBg,
} satisfies Record<BackgroundSource["type"], string>;

const BACKGROUND_SOURCES_LIST = [
	"wallpaper",
	"image",
	"color",
	"gradient",
] satisfies Array<BackgroundSource["type"]>;

const BACKGROUND_COLORS = [
	"#FF0000", // Red
	"#FF4500", // Orange-Red
	"#FF8C00", // Orange
	"#FFD700", // Gold
	"#FFFF00", // Yellow
	"#ADFF2F", // Green-Yellow
	"#32CD32", // Lime Green
	"#008000", // Green
	"#00CED1", // Dark Turquoise
	"#4785FF", // Dodger Blue
	"#0000FF", // Blue
	"#4B0082", // Indigo
	"#800080", // Purple
	"#A9A9A9", // Dark Gray
	"#FFFFFF", // White
	"#000000", // Black
	"#00000000", // Transparent
];

const BACKGROUND_GRADIENTS = [
	{ from: [15, 52, 67], to: [52, 232, 158] }, // Dark Blue to Teal
	{ from: [34, 193, 195], to: [253, 187, 45] }, // Turquoise to Golden Yellow
	{ from: [29, 253, 251], to: [195, 29, 253] }, // Cyan to Purple
	{ from: [69, 104, 220], to: [176, 106, 179] }, // Blue to Violet
	{ from: [106, 130, 251], to: [252, 92, 125] }, // Soft Blue to Pinkish Red
	{ from: [131, 58, 180], to: [253, 29, 29] }, // Purple to Red
	{ from: [249, 212, 35], to: [255, 78, 80] }, // Yellow to Coral Red
	{ from: [255, 94, 0], to: [255, 42, 104] }, // Orange to Reddish Pink
	{ from: [255, 0, 150], to: [0, 204, 255] }, // Pink to Sky Blue
	{ from: [0, 242, 96], to: [5, 117, 230] }, // Green to Blue
	{ from: [238, 205, 163], to: [239, 98, 159] }, // Peach to Soft Pink
	{ from: [44, 62, 80], to: [52, 152, 219] }, // Dark Gray Blue to Light Blue
	{ from: [168, 239, 255], to: [238, 205, 163] }, // Light Blue to Peach
	{ from: [74, 0, 224], to: [143, 0, 255] }, // Deep Blue to Bright Purple
	{ from: [252, 74, 26], to: [247, 183, 51] }, // Deep Orange to Soft Yellow
	{ from: [0, 255, 255], to: [255, 20, 147] }, // Cyan to Deep Pink
	{ from: [255, 127, 0], to: [255, 255, 0] }, // Orange to Yellow
	{ from: [255, 0, 255], to: [0, 255, 0] }, // Magenta to Green
] satisfies Array<{ from: RGBColor; to: RGBColor }>;

const WALLPAPER_NAMES = [
	// macOS wallpapers
	"macOS/tahoe-dusk-min",
	"macOS/tahoe-dawn-min",
	"macOS/tahoe-day-min",
	"macOS/tahoe-night-min",
	"macOS/tahoe-dark",
	"macOS/tahoe-light",
	"macOS/sequoia-dark",
	"macOS/sequoia-light",
	"macOS/sonoma-clouds",
	"macOS/sonoma-dark",
	"macOS/sonoma-evening",
	"macOS/sonoma-fromabove",
	"macOS/sonoma-horizon",
	"macOS/sonoma-light",
	"macOS/sonoma-river",
	"macOS/ventura-dark",
	"macOS/ventura-semi-dark",
	"macOS/ventura",
	// Blue wallpapers
	"blue/1",
	"blue/2",
	"blue/3",
	"blue/4",
	"blue/5",
	"blue/6",
	// Purple wallpapers
	"purple/1",
	"purple/2",
	"purple/3",
	"purple/4",
	"purple/5",
	"purple/6",
	// Dark wallpapers
	"dark/1",
	"dark/2",
	"dark/3",
	"dark/4",
	"dark/5",
	"dark/6",
	// Orange wallpapers
	"orange/1",
	"orange/2",
	"orange/3",
	"orange/4",
	"orange/5",
	"orange/6",
	"orange/7",
	"orange/8",
	"orange/9",
] as const;

const STEREO_MODES = [
	{ name: "Stereo", value: "stereo" },
	{ name: "Mono L", value: "monoL" },
	{ name: "Mono R", value: "monoR" },
] satisfies Array<{ name: string; value: StereoMode }>;

const CAMERA_SHAPES = [
	{
		name: "Square",
		value: "square",
	},
	{
		name: "Source",
		value: "source",
	},
] satisfies Array<{ name: string; value: CameraShape }>;

const CORNER_STYLE_OPTIONS = [
	{ name: "Squircle", value: "squircle" },
	{ name: "Rounded", value: "rounded" },
] satisfies Array<{ name: string; value: CornerRoundingType }>;

const BACKGROUND_THEMES = {
	macOS: "macOS",
	dark: "Dark",
	blue: "Blue",
	purple: "Purple",
	orange: "Orange",
};

type CursorPresetValues = {
	tension: number;
	mass: number;
	friction: number;
};

const DEFAULT_CURSOR_MOTION_BLUR = 0.5;

const CURSOR_TYPE_OPTIONS = [
	{
		value: "auto" as CursorType,
		label: "Auto",
		description: "Uses the actual cursor from your recording.",
	},
	{
		value: "circle" as CursorType,
		label: "Circle",
		description: "A touch-style circle cursor like mobile simulators.",
	},
];

const CURSOR_ANIMATION_STYLE_OPTIONS = [
	{
		value: "slow",
		label: "Slow",
		description: "Relaxed easing with a gentle follow and higher inertia.",
		preset: { tension: 65, mass: 1.8, friction: 16 },
	},
	{
		value: "mellow",
		label: "Mellow",
		description: "Balanced smoothing for everyday tutorials and walkthroughs.",
		preset: { tension: 120, mass: 1.1, friction: 18 },
	},
	{
		value: "custom",
		label: "Custom",
		description: "Tune tension, friction, and mass manually for full control.",
	},
] satisfies Array<{
	value: CursorAnimationStyle;
	label: string;
	description: string;
	preset?: CursorPresetValues;
}>;

const CURSOR_PRESET_TOLERANCE = {
	tension: 1,
	mass: 0.05,
	friction: 0.2,
} as const;

const findCursorPreset = (
	values: CursorPresetValues,
): CursorAnimationStyle | null => {
	const preset = CURSOR_ANIMATION_STYLE_OPTIONS.find(
		(option) =>
			option.preset &&
			Math.abs(option.preset.tension - values.tension) <=
				CURSOR_PRESET_TOLERANCE.tension &&
			Math.abs(option.preset.mass - values.mass) <=
				CURSOR_PRESET_TOLERANCE.mass &&
			Math.abs(option.preset.friction - values.friction) <=
				CURSOR_PRESET_TOLERANCE.friction,
	);

	return preset?.value ?? null;
};

const TAB_IDS = {
	background: "background",
	camera: "camera",
	transcript: "transcript",
	audio: "audio",
	cursor: "cursor",
	hotkeys: "hotkeys",
} as const;

export function ConfigSidebar() {
	const {
		project,
		setProject,
		setEditorState,
		projectActions,
		editorInstance,
		editorState,
		meta,
	} = useEditorContext();

	const cursorIdleDelay = () =>
		((project.cursor as { hideWhenIdleDelay?: number }).hideWhenIdleDelay ??
			2) as number;

	const clampIdleDelay = (value: number) =>
		Math.round(Math.min(5, Math.max(0.5, value)) * 10) / 10;

	type CursorPhysicsKey = "tension" | "mass" | "friction";

	const setCursorPhysics = (key: CursorPhysicsKey, value: number) => {
		const nextValues: CursorPresetValues = {
			tension: key === "tension" ? value : project.cursor.tension,
			mass: key === "mass" ? value : project.cursor.mass,
			friction: key === "friction" ? value : project.cursor.friction,
		};
		const matched = findCursorPreset(nextValues);
		const nextStyle = (matched ?? "custom") as CursorAnimationStyle;

		batch(() => {
			setProject("cursor", key, value);
			if (project.cursor.animationStyle !== nextStyle) {
				setProject("cursor", "animationStyle", nextStyle);
			}
		});
	};

	const applyCursorStylePreset = (style: CursorAnimationStyle) => {
		const option = CURSOR_ANIMATION_STYLE_OPTIONS.find(
			(item) => item.value === style,
		);

		batch(() => {
			setProject("cursor", "animationStyle", style);
			if (option?.preset) {
				setProject("cursor", "tension", option.preset.tension);
				setProject("cursor", "mass", option.preset.mass);
				setProject("cursor", "friction", option.preset.friction);
			}
		});
	};

	const [state, setState] = createStore({
		selectedTab: "background" as
			| "background"
			| "camera"
			| "transcript"
			| "audio"
			| "cursor"
			| "hotkeys"
			| "captions"
			| "keyboard",
	});

	let scrollRef!: HTMLDivElement;

	return (
		<KTabs
			value={editorState.timeline.selection ? undefined : state.selectedTab}
			class="flex flex-col min-h-0 shrink-0 flex-1 max-w-[26rem] overflow-hidden rounded-xl z-10 bg-gray-1 dark:bg-gray-2 border border-gray-3"
		>
			<KTabs.List class="flex overflow-hidden sticky top-0 z-[60] flex-row items-center h-16 text-lg border-b border-gray-3 shrink-0 bg-gray-1 dark:bg-gray-2">
				<For
					each={[
						{ id: TAB_IDS.background, icon: IconCapImage },
						{
							id: TAB_IDS.camera,
							icon: IconCapCamera,
							disabled: editorInstance.recordings.segments.every(
								(s) => s.camera === null,
							),
						},
						{ id: TAB_IDS.audio, icon: IconCapAudioOn },
						{
							id: TAB_IDS.cursor,
							icon: IconCapCursor,
							disabled: !(
								meta().type === "multiple" && (meta() as any).segments[0].cursor
							),
						},
						{
							id: "captions" as const,
							icon: IconCapMessageBubble,
						},
						{
							id: "keyboard" as const,
							icon: IconLucideKeyboard,
						},
					].filter(Boolean)}
				>
					{(item) => (
						<KTabs.Trigger
							value={item.id}
							class={cx(
								"flex relative z-10 flex-1 justify-center items-center px-4 py-2 transition-colors group disabled:opacity-50 focus:outline-none",
								editorState.timeline.selection
									? "text-gray-11"
									: "text-gray-11 ui-selected:text-gray-12",
							)}
							onClick={() => {
								// Clear any active selection first
								if (editorState.timeline.selection) {
									setEditorState("timeline", "selection", null);
								}
								setState("selectedTab", item.id);
								scrollRef.scrollTo({
									top: 0,
								});
							}}
							disabled={item.disabled}
						>
							<div
								class={cx(
									"flex justify-center relative border-transparent border z-10 items-center rounded-md size-9 transition will-change-transform",
									state.selectedTab !== item.id &&
										"group-hover:border-gray-300 group-disabled:border-none",
								)}
							>
								<Dynamic component={item.icon} />
							</div>
						</KTabs.Trigger>
					)}
				</For>

				{/** Center the indicator with the icon */}
				<Show when={!editorState.timeline.selection}>
					<KTabs.Indicator class="absolute top-0 left-0 w-full h-full transition-transform duration-200 ease-in-out pointer-events-none will-change-transform">
						<div class="absolute top-1/2 left-1/2 rounded-lg transform -translate-x-1/2 -translate-y-1/2 bg-gray-3 will-change-transform size-9" />
					</KTabs.Indicator>
				</Show>
			</KTabs.List>
			<div
				ref={scrollRef}
				style={{
					"--margin-top-scroll": "5px",
				}}
				class="custom-scroll overflow-x-hidden overflow-y-scroll text-[0.875rem] flex-1 min-h-0"
				classList={{
					hidden: !!editorState.timeline.selection,
				}}
			>
				<BackgroundConfig scrollRef={scrollRef} />
				<CameraConfig scrollRef={scrollRef} />
				<KTabs.Content
					value="audio"
					class="flex flex-col flex-1 gap-6 p-4 min-h-0"
				>
					<Field
						name="Audio Controls"
						icon={<IconLucideVolume2 class="size-4" />}
					>
						<Subfield name="Mute Audio">
							<Toggle
								checked={project.audio.mute}
								onChange={(v) => setProject("audio", "mute", v)}
							/>
						</Subfield>
						{editorInstance.recordings.segments[0].mic?.channels === 2 && (
							<Subfield name="Microphone Stereo Mode">
								<KSelect<{ name: string; value: StereoMode }>
									options={STEREO_MODES}
									optionValue="value"
									optionTextValue="name"
									value={STEREO_MODES.find(
										(v) => v.value === project.audio.micStereoMode,
									)}
									onChange={(v) => {
										if (v) setProject("audio", "micStereoMode", v.value);
									}}
									disallowEmptySelection
									itemComponent={(props) => (
										<MenuItem<typeof KSelect.Item>
											as={KSelect.Item}
											item={props.item}
										>
											<KSelect.ItemLabel class="flex-1">
												{props.item.rawValue.name}
											</KSelect.ItemLabel>
										</MenuItem>
									)}
								>
									<KSelect.Trigger class="flex flex-row gap-2 items-center px-2 w-full h-8 rounded-lg transition-colors bg-gray-3 disabled:text-gray-11">
										<KSelect.Value<{
											name: string;
											value: StereoMode;
										}> class="flex-1 text-sm text-left truncate text-[--gray-500] font-normal">
											{(state) => <span>{state.selectedOption().name}</span>}
										</KSelect.Value>
										<KSelect.Icon<ValidComponent>
											as={(props) => (
												<IconCapChevronDown
													{...props}
													class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180 text-[--gray-500]"
												/>
											)}
										/>
									</KSelect.Trigger>
									<KSelect.Portal>
										<PopperContent<typeof KSelect.Content>
											as={KSelect.Content}
											class={cx(topSlideAnimateClasses, "z-50")}
										>
											<MenuItemList<typeof KSelect.Listbox>
												class="overflow-y-auto max-h-32"
												as={KSelect.Listbox}
											/>
										</PopperContent>
									</KSelect.Portal>
								</KSelect>
							</Subfield>
						)}

						{/* <Subfield name="Mute Audio">
                <Toggle
                  checked={project.audio.mute}
                  onChange={(v) => setProject("audio", "mute", v)}
                />
              </Subfield> */}

						{/* <ComingSoonTooltip>
                <Subfield name="Improve Mic Quality">
                  <Toggle disabled />
                </Subfield>
              </ComingSoonTooltip> */}
					</Field>
					{meta().hasMicrophone && (
						<Field
							name="Microphone Volume"
							icon={<IconCapMicrophone class="size-4" />}
						>
							<Slider
								disabled={project.audio.mute}
								value={[project.audio.micVolumeDb ?? 0]}
								onChange={(v) => setProject("audio", "micVolumeDb", v[0])}
								minValue={-30}
								maxValue={10}
								step={0.1}
								formatTooltip={(v) =>
									v <= -30 ? "Muted" : `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`
								}
							/>
						</Field>
					)}
					{meta().hasSystemAudio && (
						<Field
							name="System Audio Volume"
							icon={<IconLucideMonitor class="size-4" />}
						>
							<Slider
								disabled={project.audio.mute}
								value={[project.audio.systemVolumeDb ?? 0]}
								onChange={(v) => setProject("audio", "systemVolumeDb", v[0])}
								minValue={-30}
								maxValue={10}
								step={0.1}
								formatTooltip={(v) =>
									v <= -30 ? "Muted" : `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`
								}
							/>
						</Field>
					)}
				</KTabs.Content>
				<KTabs.Content
					value="cursor"
					class="flex flex-col flex-1 gap-6 p-4 min-h-0"
				>
					<Field
						name="Cursor"
						icon={<IconCapCursor />}
						value={
							<Toggle
								checked={!project.cursor.hide}
								onChange={(v) => {
									setProject("cursor", "hide", !v);
								}}
							/>
						}
					/>
					<Show when={!project.cursor.hide}>
						<Field name="Cursor Type" icon={<IconCapCursor />}>
							<RadioGroup
								class="flex flex-col gap-2"
								value={project.cursor.type}
								onChange={(value) =>
									setProject("cursor", "type", value as CursorType)
								}
							>
								{CURSOR_TYPE_OPTIONS.map((option) => (
									<RadioGroup.Item
										value={option.value}
										class="rounded-lg border border-gray-3 transition-colors ui-checked:border-blue-8 ui-checked:bg-blue-3/40"
									>
										<RadioGroup.ItemInput class="sr-only" />
										<RadioGroup.ItemLabel class="flex cursor-pointer items-start gap-3 p-3">
											<RadioGroup.ItemControl class="mt-1 size-4 rounded-full border border-gray-7 ui-checked:border-blue-9 ui-checked:bg-blue-9" />
											<div class="flex flex-col text-left">
												<span class="text-sm font-medium text-gray-12">
													{option.label}
												</span>
												<span class="text-xs text-gray-11">
													{option.description}
												</span>
											</div>
										</RadioGroup.ItemLabel>
									</RadioGroup.Item>
								))}
							</RadioGroup>
						</Field>
						<Field name="Size" icon={<IconCapEnlarge />}>
							<Slider
								value={[project.cursor.size]}
								onChange={(v) => setProject("cursor", "size", v[0])}
								minValue={20}
								maxValue={300}
								step={1}
							/>
						</Field>
						<Field
							name="Hide When Idle"
							icon={<IconLucideTimer class="size-4" />}
							value={
								<Toggle
									checked={project.cursor.hideWhenIdle}
									onChange={(value) =>
										setProject("cursor", "hideWhenIdle", value)
									}
								/>
							}
						/>
						<Show when={project.cursor.hideWhenIdle}>
							<Subfield name="Inactivity Delay" class="gap-4 items-center">
								<div class="flex flex-1 gap-3 items-center">
									<Slider
										class="flex-1"
										value={[cursorIdleDelay()]}
										onChange={(v) => {
											const rounded = clampIdleDelay(v[0]);
											setProject("cursor", "hideWhenIdleDelay" as any, rounded);
										}}
										minValue={0.5}
										maxValue={5}
										step={0.1}
										formatTooltip={(value) => `${value.toFixed(1)}s`}
									/>
									<span class="w-12 text-xs text-right text-gray-11">
										{cursorIdleDelay().toFixed(1)}s
									</span>
								</div>
							</Subfield>
						</Show>
						<Field
							name="Cursor Movement Style"
							icon={<IconLucideRabbit class="size-4" />}
						>
							<RadioGroup
								class="flex flex-col gap-2"
								value={project.cursor.animationStyle}
								onChange={(value) =>
									applyCursorStylePreset(value as CursorAnimationStyle)
								}
							>
								{CURSOR_ANIMATION_STYLE_OPTIONS.map((option) => (
									<RadioGroup.Item
										value={option.value}
										class="rounded-lg border border-gray-3 transition-colors ui-checked:border-blue-8 ui-checked:bg-blue-3/40"
									>
										<RadioGroup.ItemInput class="sr-only" />
										<RadioGroup.ItemLabel class="flex cursor-pointer items-start gap-3 p-3">
											<RadioGroup.ItemControl class="mt-1 size-4 rounded-full border border-gray-7 ui-checked:border-blue-9 ui-checked:bg-blue-9" />
											<div class="flex flex-col text-left">
												<span class="text-sm font-medium text-gray-12">
													{option.label}
												</span>
												<span class="text-xs text-gray-11">
													{option.description}
												</span>
											</div>
										</RadioGroup.ItemLabel>
									</RadioGroup.Item>
								))}
							</RadioGroup>
						</Field>
						<KCollapsible open={!project.cursor.raw}>
							<Field
								name="Smooth Movement"
								icon={<IconHugeiconsEaseCurveControlPoints />}
								value={
									<Toggle
										checked={!project.cursor.raw}
										onChange={(value) => {
											setProject("cursor", "raw", !value);
										}}
									/>
								}
							/>
							<KCollapsible.Content class="overflow-hidden border-b opacity-0 transition-opacity border-gray-3 animate-collapsible-up ui-expanded:animate-collapsible-down ui-expanded:opacity-100">
								{/* if Content has padding or margin the animation doesn't look as good */}
								<div class="flex flex-col gap-4 pt-4 pb-6">
									<Field name="Tension">
										<Slider
											value={[project.cursor.tension]}
											onChange={(v) => setCursorPhysics("tension", v[0])}
											minValue={1}
											maxValue={500}
											step={1}
										/>
									</Field>
									<Field name="Friction">
										<Slider
											value={[project.cursor.friction]}
											onChange={(v) => setCursorPhysics("friction", v[0])}
											minValue={0}
											maxValue={50}
											step={0.1}
										/>
									</Field>
									<Field name="Mass">
										<Slider
											value={[project.cursor.mass]}
											onChange={(v) => setCursorPhysics("mass", v[0])}
											minValue={0.1}
											maxValue={10}
											step={0.01}
										/>
									</Field>
								</div>
							</KCollapsible.Content>
						</KCollapsible>
						<Field
							name="High Quality SVG Cursors"
							icon={<IconLucideSparkles />}
							value={
								<Toggle
									checked={(project.cursor as any).useSvg ?? true}
									onChange={(value) => {
										setProject("cursor", "useSvg" as any, value);
									}}
								/>
							}
						/>
					</Show>

					{/* <Field name="Animation Style" icon={<IconLucideRabbit />}>
            <RadioGroup
              defaultValue="regular"
              value={project.cursor.animationStyle}
              onChange={(value) => {
                setProject(
                  "cursor",
                  "animationStyle",
                  value as CursorAnimationStyle
                );
              }}
              class="flex flex-col gap-2"
              disabled
            >
              {(
                Object.entries(CURSOR_ANIMATION_STYLES) as [
                  CursorAnimationStyle,
                  string
                ][]
              ).map(([value, label]) => (
                <RadioGroup.Item value={value} class="flex items-center">
                  <RadioGroup.ItemInput class="sr-only peer" />
                  <RadioGroup.ItemControl
                    class={cx(
                      "mr-2 w-4 h-4 rounded-full border border-gray-300",
                      "relative after:absolute after:inset-0 after:m-auto after:block after:w-2 after:h-2 after:rounded-full",
                      "after:transition-colors after:duration-200",
                      "peer-checked:border-blue-500 peer-checked:after:bg-blue-400",
                      "peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400/50",
                      "peer-disabled:opacity-50"
                    )}
                  />
                  <span
                    class={cx(
                      "text-gray-12",
                      "peer-checked:text-gray-900",
                      "peer-disabled:opacity-50"
                    )}
                  >
                    {label}
                  </span>
                </RadioGroup.Item>
              ))}
            </RadioGroup>
          </Field> */}
				</KTabs.Content>
				<KTabs.Content value="hotkeys" class="flex flex-1 p-4 min-h-0">
					<Field name="Hotkeys" icon={<IconCapHotkeys />}>
						<ComingSoonTooltip>
							<Subfield name="Show hotkeys">
								<Toggle disabled />
							</Subfield>
						</ComingSoonTooltip>
					</Field>
				</KTabs.Content>
				<KTabs.Content
					value="captions"
					class="flex flex-col flex-1 gap-6 p-4 min-h-0"
				>
					<CaptionsTab />
				</KTabs.Content>
				<KTabs.Content
					value="keyboard"
					class="flex flex-col flex-1 gap-6 p-4 min-h-0"
				>
					<KeyboardTab />
				</KTabs.Content>
			</div>
			<div
				style={{
					"--margin-top-scroll": "5px",
				}}
				class="custom-scroll p-4 top-16 left-0 right-0 bottom-0 text-[0.875rem] space-y-4 bg-gray-1 dark:bg-gray-2 z-50"
				classList={{
					hidden: !editorState.timeline.selection,
					"animate-in slide-in-from-bottom-2 fade-in":
						!!editorState.timeline.selection,
				}}
			>
				<Show when={editorState.timeline.selection}>
					{(selection) => (
						<Suspense>
							<Show
								when={(() => {
									const textSelection = selection();
									if (textSelection.type !== "text") return;

									const segments = textSelection.indices
										.map((index) => ({
											index,
											segment: project.timeline?.textSegments?.[index],
										}))
										.filter(
											(item): item is { index: number; segment: TextSegment } =>
												item.segment !== undefined,
										);

									if (segments.length === 0) {
										setEditorState("timeline", "selection", null);
										return;
									}
									return { selection: textSelection, segments };
								})()}
							>
								{(value) => (
									<div class="space-y-4">
										<div class="flex flex-row justify-between items-center">
											<div class="flex gap-2 items-center">
												<EditorButton
													onClick={() =>
														setEditorState("timeline", "selection", null)
													}
													leftIcon={<IconLucideCheck />}
												>
													Done
												</EditorButton>
												<span class="text-sm text-gray-10">
													{value().segments.length} text{" "}
													{value().segments.length === 1
														? "segment"
														: "segments"}{" "}
													selected
												</span>
											</div>
											<EditorButton
												variant="danger"
												onClick={() =>
													projectActions.deleteTextSegments(
														value().segments.map((s) => s.index),
													)
												}
												leftIcon={<IconCapTrash />}
											>
												Delete
											</EditorButton>
										</div>
										<For each={value().segments}>
											{(item) => (
												<div class="p-4 rounded-lg border border-gray-200">
													<TextSegmentConfig
														segment={item.segment}
														segmentIndex={item.index}
													/>
												</div>
											)}
										</For>
									</div>
								)}
							</Show>
							<Show
								when={(() => {
									const maskSelection = selection();
									if (maskSelection.type !== "mask") return;

									const segments = maskSelection.indices
										.map((index) => ({
											index,
											segment: project.timeline?.maskSegments?.[index],
										}))
										.filter(
											(item): item is { index: number; segment: MaskSegment } =>
												item.segment !== undefined,
										);

									if (segments.length === 0) {
										setEditorState("timeline", "selection", null);
										return;
									}
									return { selection: maskSelection, segments };
								})()}
							>
								{(value) => (
									<div class="space-y-4">
										<div class="flex flex-row justify-between items-center">
											<div class="flex gap-2 items-center">
												<EditorButton
													onClick={() =>
														setEditorState("timeline", "selection", null)
													}
													leftIcon={<IconLucideCheck />}
												>
													Done
												</EditorButton>
												<span class="text-sm text-gray-10">
													{value().segments.length} mask{" "}
													{value().segments.length === 1
														? "segment"
														: "segments"}{" "}
													selected
												</span>
											</div>
											<EditorButton
												variant="danger"
												onClick={() =>
													projectActions.deleteMaskSegments(
														value().segments.map((s) => s.index),
													)
												}
												leftIcon={<IconCapTrash />}
											>
												Delete
											</EditorButton>
										</div>
										<For each={value().segments}>
											{(item) => (
												<div class="p-4 rounded-lg border border-gray-200">
													<MaskSegmentConfig
														segment={item.segment}
														segmentIndex={item.index}
													/>
												</div>
											)}
										</For>
									</div>
								)}
							</Show>
							<Show
								when={(() => {
									const zoomSelection = selection();
									if (zoomSelection.type !== "zoom") return;

									const segments = zoomSelection.indices
										.map((index) => ({
											index,
											segment: project.timeline?.zoomSegments?.[index],
										}))
										.filter(
											(item): item is { index: number; segment: ZoomSegment } =>
												item.segment !== undefined,
										);

									if (segments.length === 0) {
										setEditorState("timeline", "selection", null);
										return;
									}
									return { selection: zoomSelection, segments };
								})()}
							>
								{(value) => (
									<div class="space-y-4">
										<div class="flex flex-row justify-between items-center">
											<div class="flex gap-2 items-center">
												<EditorButton
													onClick={() =>
														setEditorState("timeline", "selection", null)
													}
													leftIcon={<IconLucideCheck />}
												>
													Done
												</EditorButton>
												<span class="text-sm text-gray-10">
													{value().segments.length} zoom{" "}
													{value().segments.length === 1
														? "segment"
														: "segments"}{" "}
													selected
												</span>
											</div>
											<EditorButton
												variant="danger"
												onClick={() => {
													projectActions.deleteZoomSegments(
														value().segments.map((s) => s.index),
													);
												}}
												leftIcon={<IconCapTrash />}
											>
												Delete
											</EditorButton>
										</div>
										<Show
											when={value().segments.length === 1}
											fallback={
												<div class="grid grid-cols-3 gap-4">
													<Index each={value().segments}>
														{(item, index) => (
															<div class="p-2.5 rounded-lg border border-gray-4 bg-gray-3">
																<ZoomSegmentPreview
																	segment={item().segment}
																	segmentIndex={index}
																/>
															</div>
														)}
													</Index>
												</div>
											}
										>
											<For each={value().segments}>
												{(item) => (
													<div class="p-4 rounded-lg border border-gray-200">
														<ZoomSegmentConfig
															segment={item.segment}
															segmentIndex={item.index}
														/>
													</div>
												)}
											</For>
										</Show>
									</div>
								)}
							</Show>
							<Show
								when={(() => {
									const sceneSelection = selection();
									if (sceneSelection.type !== "scene") return;

									const segments = sceneSelection.indices
										.map((idx) => ({
											segment: project.timeline?.sceneSegments?.[idx],
											index: idx,
										}))
										.filter((s) => s.segment !== undefined);

									if (segments.length === 0) return;
									return { selection: sceneSelection, segments };
								})()}
							>
								{(value) => (
									<Show
										when={value().segments.length > 1}
										fallback={
											<SceneSegmentConfig
												segment={value().segments[0].segment!}
												segmentIndex={value().segments[0].index}
											/>
										}
									>
										<div class="space-y-4">
											<div class="flex flex-row justify-between items-center">
												<div class="flex gap-2 items-center">
													<EditorButton
														onClick={() =>
															setEditorState("timeline", "selection", null)
														}
														leftIcon={<IconLucideCheck />}
													>
														Done
													</EditorButton>
													<span class="text-sm text-gray-10">
														{value().segments.length} scene{" "}
														{value().segments.length === 1
															? "segment"
															: "segments"}{" "}
														selected
													</span>
												</div>
												<EditorButton
													variant="danger"
													onClick={() => {
														const indices = value().selection.indices;

														// Delete segments in reverse order to maintain indices
														[...indices]
															.sort((a, b) => b - a)
															.forEach((idx) => {
																projectActions.deleteSceneSegment(idx);
															});
													}}
													leftIcon={<IconCapTrash />}
												>
													Delete
												</EditorButton>
											</div>
										</div>
									</Show>
								)}
							</Show>
							<Show
								when={(() => {
									const clipSelection = selection();
									if (clipSelection.type !== "clip") return;

									const segments = clipSelection.indices
										.map((idx) => ({
											segment: project.timeline?.segments?.[idx],
											index: idx,
										}))
										.filter((s) => s.segment !== undefined);

									if (segments.length === 0) return;
									return { selection: clipSelection, segments };
								})()}
							>
								{(value) => (
									<Show
										when={value().segments.length > 1}
										fallback={
											<ClipSegmentConfig
												segment={value().segments[0].segment!}
												segmentIndex={value().segments[0].index}
											/>
										}
									>
										<div class="space-y-4">
											<div class="flex flex-row justify-between items-center">
												<div class="flex gap-2 items-center">
													<EditorButton
														onClick={() =>
															setEditorState("timeline", "selection", null)
														}
														leftIcon={<IconLucideCheck />}
													>
														Done
													</EditorButton>
													<span class="text-sm text-gray-10">
														{value().segments.length} clip{" "}
														{value().segments.length === 1
															? "segment"
															: "segments"}{" "}
														selected
													</span>
												</div>
												<EditorButton
													variant="danger"
													onClick={() => {
														const indices = value().selection.indices;

														// Delete segments in reverse order to maintain indices
														[...indices]
															.sort((a, b) => b - a)
															.forEach((idx) => {
																projectActions.deleteClipSegment(idx);
															});
													}}
													leftIcon={<IconCapTrash />}
												>
													Delete
												</EditorButton>
											</div>
										</div>
									</Show>
								)}
							</Show>
						</Suspense>
					)}
				</Show>
			</div>
		</KTabs>
	);
}

function BackgroundConfig(props: { scrollRef: HTMLDivElement }) {
	const { project, setProject, projectHistory } = useEditorContext();

	// Background tabs
	const [backgroundTab, setBackgroundTab] =
		createSignal<keyof typeof BACKGROUND_THEMES>("macOS");

	const [wallpapers] = createResource(async () => {
		// Only load visible wallpapers initially
		const visibleWallpaperPaths = WALLPAPER_NAMES.map(async (id) => {
			try {
				const path = await resolveResource(`assets/backgrounds/${id}.jpg`);
				return { id, path };
			} catch (_err) {
				return { id, path: null };
			}
		});

		// Load initial batch
		const initialPaths = await Promise.all(visibleWallpaperPaths);

		return initialPaths
			.filter((p) => p.path !== null)
			.map(({ id, path }) => ({
				id,
				url: convertFileSrc(path!),
				rawPath: path!,
			}));
	});

	// set padding if background is selected
	const ensurePaddingForBackground = () => {
		if (project.background.padding === 0)
			setProject("background", "padding", 10);
	};

	// Validate background source path on mount
	onMount(async () => {
		if (
			project.background.source.type === "wallpaper" ||
			project.background.source.type === "image"
		) {
			const path = project.background.source.path;

			if (path) {
				if (project.background.source.type === "wallpaper") {
					// If the path is just the wallpaper ID (e.g. "sequoia-dark"), get the full path
					if (
						WALLPAPER_NAMES.includes(path as (typeof WALLPAPER_NAMES)[number])
					) {
						// Wait for wallpapers to load
						const loadedWallpapers = wallpapers();
						if (!loadedWallpapers) return;

						// Find the wallpaper with matching ID
						const wallpaper = loadedWallpapers.find((w) => w.id === path);
						if (!wallpaper?.url) return;

						// Directly trigger the radio group's onChange handler
						const radioGroupOnChange = async (photoUrl: string) => {
							try {
								const wallpaper = wallpapers()?.find((w) => w.url === photoUrl);
								if (!wallpaper) return;

								// Get the raw path without any URL prefixes
								const rawPath = decodeURIComponent(
									photoUrl.replace("file://", ""),
								);

								setWallpaperSource(rawPath);
							} catch (_err) {
								toast.error("Failed to set wallpaper");
							}
						};

						await radioGroupOnChange(wallpaper.url);
					}
				} else if (project.background.source.type === "image") {
					(async () => {
						try {
							const convertedPath = convertFileSrc(path);
							await fetch(convertedPath, { method: "HEAD" });
						} catch (_err) {
							setProject("background", "source", {
								type: "image",
								path: null,
							});
						}
					})();
				}
			}
		}
	});

	const filteredWallpapers = createMemo(() => {
		const currentTab = backgroundTab();
		return wallpapers()?.filter((wp) => wp.id.startsWith(currentTab)) || [];
	});

	const [scrollX, setScrollX] = createSignal(0);
	const [reachedEndOfScroll, setReachedEndOfScroll] = createSignal(false);

	const [backgroundRef, setBackgroundRef] = createSignal<HTMLDivElement>();

	createEventListenerMap(
		() => backgroundRef() ?? [],
		{
			/** Handle background tabs overflowing to show fade */
			scroll: () => {
				const el = backgroundRef();
				if (el) {
					setScrollX(el.scrollLeft);
					const reachedEnd = el.scrollWidth - el.clientWidth - el.scrollLeft;
					setReachedEndOfScroll(reachedEnd === 0);
				}
			},
			//Mouse wheel and touchpad support
			wheel: (e: WheelEvent) => {
				const el = backgroundRef();
				if (el) {
					e.preventDefault();
					el.scrollLeft +=
						Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
				}
			},
		},
		{ passive: false },
	);

	let fileInput!: HTMLInputElement;

	const setWallpaperSource = (wallpaperPath: string) => {
		const resumeHistory = projectHistory.pause();
		batch(() => {
			setProject("background", "source", {
				type: "wallpaper",
				path: wallpaperPath,
			} as const);
			resumeHistory();
		});
	};

	const backgrounds: {
		[K in BackgroundSource["type"]]: Extract<BackgroundSource, { type: K }>;
	} = {
		wallpaper: {
			type: "wallpaper",
			path: null,
		},
		image: {
			type: "image",
			path: null,
		},
		color: {
			type: "color",
			value: DEFAULT_GRADIENT_FROM,
		},
		gradient: {
			type: "gradient",
			from: DEFAULT_GRADIENT_FROM,
			to: DEFAULT_GRADIENT_TO,
		},
	};

	const hapticsEnabled = ostype() === "macos";

	return (
		<KTabs.Content value={TAB_IDS.background} class="flex flex-col gap-6 p-4">
			<Field icon={<IconCapImage class="size-4" />} name="Background Image">
				<KTabs
					value={project.background.source.type}
					onChange={(v) => {
						const tab = v as BackgroundSource["type"];
						ensurePaddingForBackground();
						switch (tab) {
							case "image": {
								setProject("background", "source", {
									type: "image",
									path:
										project.background.source.type === "image"
											? project.background.source.path
											: null,
								});
								break;
							}
							case "color": {
								setProject("background", "source", {
									type: "color",
									value:
										project.background.source.type === "color"
											? project.background.source.value
											: DEFAULT_GRADIENT_FROM,
								});
								break;
							}
							case "gradient": {
								setProject("background", "source", {
									type: "gradient",
									from:
										project.background.source.type === "gradient"
											? project.background.source.from
											: DEFAULT_GRADIENT_FROM,
									to:
										project.background.source.type === "gradient"
											? project.background.source.to
											: DEFAULT_GRADIENT_TO,
									angle:
										project.background.source.type === "gradient"
											? project.background.source.angle
											: 90,
								});
								break;
							}
							case "wallpaper": {
								setProject("background", "source", {
									type: "wallpaper",
									path:
										project.background.source.type === "wallpaper"
											? project.background.source.path
											: null,
								});
								break;
							}
						}
					}}
				>
					<KTabs.List class="flex flex-row gap-2 items-center rounded-[0.5rem] relative">
						<For each={BACKGROUND_SOURCES_LIST}>
							{(item) => {
								const el = (props?: object) => (
									<KTabs.Trigger
										class="z-10 flex-1 py-2.5 px-2 text-xs text-gray-11  ui-selected:border-gray-3 ui-selected:bg-gray-3 ui-not-selected:hover:border-gray-7 rounded-[10px] transition-colors duration-200 outline-none border ui-selected:text-gray-12 peer"
										value={item}
										{...props}
									>
										<div class="flex gap-1.5 justify-center items-center">
											{(() => {
												const getGradientBackground = () => {
													const angle =
														project.background.source.type === "gradient"
															? project.background.source.angle
															: 90;
													const fromColor =
														project.background.source.type === "gradient"
															? project.background.source.from
															: DEFAULT_GRADIENT_FROM;
													const toColor =
														project.background.source.type === "gradient"
															? project.background.source.to
															: DEFAULT_GRADIENT_TO;

													return (
														<div
															class="size-3.5 rounded"
															style={{
																background: `linear-gradient(${angle}deg, rgb(${fromColor}), rgb(${toColor}))`,
															}}
														/>
													);
												};

												const getColorBackground = () => {
													const backgroundColor =
														project.background.source.type === "color"
															? project.background.source.value
															: hexToRgb(BACKGROUND_COLORS[9]);

													return (
														<div
															class="size-3.5 rounded-[5px]"
															style={{
																"background-color": `rgb(${backgroundColor})`,
															}}
														/>
													);
												};

												const getImageBackground = () => {
													// Always start with the default icon
													let imageSrc: string = BACKGROUND_ICONS[item];

													// Only override for "image" if a valid path exists
													if (
														item === "image" &&
														project.background.source.type === "image" &&
														project.background.source.path
													) {
														const convertedPath = convertFileSrc(
															project.background.source.path,
														);
														// Only use converted path if it's valid
														if (convertedPath) {
															imageSrc = convertedPath;
														}
													}
													// Only override for "wallpaper" if a valid wallpaper is found
													else if (
														item === "wallpaper" &&
														project.background.source.type === "wallpaper" &&
														project.background.source.path
													) {
														const selectedWallpaper = wallpapers()?.find((w) =>
															(
																project.background.source as { path?: string }
															).path?.includes(w.id),
														);
														// Only use wallpaper URL if it exists
														if (selectedWallpaper?.url) {
															imageSrc = selectedWallpaper.url;
														}
													}

													return (
														<img
															loading="eager"
															alt={BACKGROUND_SOURCES[item]}
															class="size-3.5 rounded"
															src={imageSrc}
														/>
													);
												};

												switch (item) {
													case "gradient":
														return getGradientBackground();
													case "color":
														return getColorBackground();
													case "image":
													case "wallpaper":
														return getImageBackground();
													default:
														return null;
												}
											})()}
											{BACKGROUND_SOURCES[item]}
										</div>
									</KTabs.Trigger>
								);

								return el({});
							}}
						</For>
					</KTabs.List>
					{/** Dashed divider */}
					<div class="my-5 w-full border-t border-dashed border-gray-5" />
					<KTabs.Content value="wallpaper">
						{/** Background Tabs */}
						<KTabs class="overflow-hidden relative" value={backgroundTab()}>
							<KTabs.List
								ref={setBackgroundRef}
								class="flex overflow-x-auto overscroll-contain relative z-10 flex-row gap-2 items-center mb-3 text-xs hide-scroll"
								style={{
									"-webkit-mask-image": `linear-gradient(to right, transparent, black ${
										scrollX() > 0 ? "24px" : "0"
									}, black calc(100% - ${
										reachedEndOfScroll() ? "0px" : "24px"
									}), transparent)`,

									"mask-image": `linear-gradient(to right, transparent, black ${
										scrollX() > 0 ? "24px" : "0"
									}, black calc(100% - ${
										reachedEndOfScroll() ? "0px" : "24px"
									}), transparent);`,
								}}
							>
								<For each={Object.entries(BACKGROUND_THEMES)}>
									{([key, value]) => (
										<>
											<KTabs.Trigger
												onClick={() =>
													setBackgroundTab(
														key as keyof typeof BACKGROUND_THEMES,
													)
												}
												value={key}
												class="flex relative z-10 flex-1 justify-center items-center px-4 py-2 bg-transparent rounded-lg border transition-colors duration-200 text-gray-11 ui-not-selected:hover:border-gray-7 ui-selected:bg-gray-3 ui-selected:border-gray-3 group ui-selected:text-gray-12 disabled:opacity-50 focus:outline-none"
											>
												{value}
											</KTabs.Trigger>
										</>
									)}
								</For>
							</KTabs.List>
						</KTabs>
						{/** End of Background Tabs */}
						<KRadioGroup
							value={
								project.background.source.type === "wallpaper"
									? (wallpapers()?.find((w) =>
											(
												project.background.source as { path?: string }
											).path?.includes(w.id),
										)?.url ?? undefined)
									: undefined
							}
							onChange={(photoUrl) => {
								try {
									const wallpaper = wallpapers()?.find(
										(w) => w.url === photoUrl,
									);
									if (!wallpaper) return;

									// Get the raw path without any URL prefixes

									setWallpaperSource(wallpaper.rawPath);

									ensurePaddingForBackground();
								} catch (_err) {
									toast.error("Failed to set wallpaper");
								}
							}}
							class="grid grid-cols-7 gap-2 h-auto"
						>
							<Show
								when={!wallpapers.loading}
								fallback={
									<div class="flex col-span-7 justify-center items-center h-32 text-gray-11">
										<div class="flex flex-col gap-2 items-center">
											<div class="w-6 h-6 rounded-full border-2 animate-spin border-gray-5 border-t-blue-400" />
											<span>Loading wallpapers...</span>
										</div>
									</div>
								}
							>
								<For each={filteredWallpapers().slice(0, 21)}>
									{(photo) => (
										<KRadioGroup.Item
											value={photo.url!}
											class="relative aspect-square group"
										>
											<KRadioGroup.ItemInput class="peer" />
											<KRadioGroup.ItemControl class="overflow-hidden w-full h-full rounded-lg transition cursor-pointer ui-not-checked:ring-offset-1 ui-not-checked:ring-offset-gray-200 ui-not-checked:hover:ring-1 ui-not-checked:hover:ring-gray-400 ui-checked:ring-2 ui-checked:ring-gray-500 ui-checked:ring-offset-2 ui-checked:ring-offset-gray-200">
												<img
													src={photo.url!}
													loading="eager"
													class="object-cover w-full h-full"
													alt="Wallpaper option"
												/>
											</KRadioGroup.ItemControl>
										</KRadioGroup.Item>
									)}
								</For>
								<Collapsible class="col-span-7">
									<Collapsible.Content class="animate-in slide-in-from-top-2 fade-in">
										<div class="grid grid-cols-7 gap-2">
											<For each={filteredWallpapers()}>
												{(photo) => (
													<KRadioGroup.Item
														value={photo.url!}
														class="relative aspect-square group"
													>
														<KRadioGroup.ItemInput class="peer" />
														<KRadioGroup.ItemControl class="overflow-hidden w-full h-full rounded-lg border cursor-pointer border-gray-5 ui-checked:border-blue-9 ui-checked:ring-2 ui-checked:ring-blue-9 peer-focus-visible:border-2 peer-focus-visible:border-blue-9">
															<img
																src={photo.url!}
																alt="Wallpaper option"
																class="object-cover w-full h-full"
																loading="lazy"
															/>
														</KRadioGroup.ItemControl>
													</KRadioGroup.Item>
												)}
											</For>
										</div>
									</Collapsible.Content>
								</Collapsible>
							</Show>
						</KRadioGroup>
					</KTabs.Content>
					<KTabs.Content value="image">
						<Show
							when={
								project.background.source.type === "image" &&
								project.background.source.path
							}
							fallback={
								<button
									type="button"
									onClick={() => fileInput.click()}
									class="p-6 bg-gray-2 text-[13px] w-full rounded-[0.5rem] border border-gray-5 border-dashed flex flex-col items-center justify-center gap-[0.5rem] hover:bg-gray-3 transition-colors duration-100"
								>
									<IconCapImage class="text-gray-11 size-6" />
									<span class="text-gray-12">
										Click to select or drag and drop image
									</span>
								</button>
							}
						>
							{(source) => (
								<div class="overflow-hidden relative w-full h-48 rounded-md border border-gray-3 group">
									<img
										src={convertFileSrc(source())}
										class="object-cover w-full h-full"
										alt="Selected background"
									/>
									<div class="absolute top-2 right-2">
										<button
											type="button"
											onClick={() =>
												setProject("background", "source", {
													type: "image",
													path: null,
												})
											}
											class="p-2 text-white rounded-full transition-colors bg-black/50 hover:bg-black/70"
										>
											<IconCapCircleX class="w-4 h-4" />
										</button>
									</div>
								</div>
							)}
						</Show>
						<input
							type="file"
							ref={fileInput}
							class="hidden"
							accept="image/apng, image/avif, image/jpeg, image/png, image/webp"
							onChange={async (e) => {
								const file = e.currentTarget.files?.[0];
								if (!file) return;

								/*
                    this is a Tauri bug in WebKit so we need to validate the file type manually
                    https://github.com/tauri-apps/tauri/issues/9158
                    */
								const validExtensions = [
									"jpg",
									"jpeg",
									"png",
									"gif",
									"webp",
									"bmp",
								];
								const extension = file.name.split(".").pop()?.toLowerCase();
								if (!extension || !validExtensions.includes(extension)) {
									toast.error("Invalid image file type");
									return;
								}

								try {
									const fileName = `bg-${Date.now()}-${file.name}`;
									const arrayBuffer = await file.arrayBuffer();
									const uint8Array = new Uint8Array(arrayBuffer);

									const fullPath = `${await appDataDir()}/${fileName}`;

									await writeFile(fileName, uint8Array, {
										baseDir: BaseDirectory.AppData,
									});

									setProject("background", "source", {
										type: "image",
										path: fullPath,
									});
								} catch (_err) {
									toast.error("Failed to save image");
								}
							}}
						/>
					</KTabs.Content>
					<KTabs.Content value="color">
						<Show
							when={
								project.background.source.type === "color" &&
								project.background.source
							}
						>
							<div class="flex flex-col flex-wrap gap-3">
								<div class="flex flex-row items-center w-full h-10">
									<RgbInput
										value={
											project.background.source.type === "color"
												? project.background.source.value
												: [0, 0, 0]
										}
										onChange={(value) => {
											setProject("background", "source", {
												type: "color",
												value,
											});
										}}
									/>
								</div>

								<div class="flex flex-wrap gap-2">
									<For each={BACKGROUND_COLORS}>
										{(color) => (
											<label class="relative">
												<input
													type="radio"
													class="sr-only peer"
													name="colorPicker"
													onChange={(e) => {
														if (!e.target.checked) return;

														const rgbValue = hexToRgb(color);
														if (!rgbValue) return;

														const [r, g, b, a] = rgbValue;
														backgrounds.color = {
															type: "color",
															value: [r, g, b],
															alpha: a,
														};

														setProject(
															"background",
															"source",
															backgrounds.color,
														);
													}}
												/>
												<div
													class="rounded-lg transition-all duration-200 cursor-pointer size-8 peer-checked:hover:opacity-100 peer-hover:opacity-70 peer-checked:ring-2 peer-checked:ring-gray-500 peer-checked:ring-offset-2 peer-checked:ring-offset-gray-200"
													style={{
														background:
															color === "#00000000"
																? CHECKERED_BUTTON_BACKGROUND
																: color,
													}}
												/>
											</label>
										)}
									</For>
								</div>
								{/* <Tooltip content="Add custom color">
                      <button
                        class="flex justify-center items-center w-6 h-6 rounded-lg border border-gray-400 border-dashed text-gray-12 hover:border-gray-500"
                        onClick={() => {
                          // Function to add a new color (you can modify this)
                          console.log(
                            "Open color picker or modal to add a color"
                          );
                        }}
                      >
                        +
                      </button>
                    </Tooltip> */}
							</div>
						</Show>
					</KTabs.Content>
					<KTabs.Content value="gradient" class="flex flex-row justify-between">
						<Show
							when={
								project.background.source.type === "gradient" &&
								project.background.source
							}
						>
							{(source) => {
								const max = 360;

								const { projectHistory } = useEditorContext();

								const angle = () => source().angle ?? 90;

								return (
									<div class="flex flex-col gap-3">
										<div class="flex gap-5 h-10">
											<RgbInput
												value={source().from}
												onChange={(from) => {
													backgrounds.gradient.from = from;
													setProject("background", "source", {
														type: "gradient",
														from,
													});
												}}
											/>
											<RgbInput
												value={source().to}
												onChange={(to) => {
													backgrounds.gradient.to = to;
													setProject("background", "source", {
														type: "gradient",
														to,
													});
												}}
											/>
											<div
												class="flex relative flex-col items-center p-1 ml-auto rounded-full border bg-gray-1 border-gray-3 size-10 cursor-ns-resize shrink-0"
												style={{ transform: `rotate(${angle()}deg)` }}
												onMouseDown={(downEvent) => {
													const start = angle();
													const _resumeHistory = projectHistory.pause();

													createRoot((dispose) =>
														createEventListenerMap(window, {
															mouseup: () => dispose(),
															mousemove: (moveEvent) => {
																const rawNewAngle =
																	Math.round(
																		start +
																			(downEvent.clientY - moveEvent.clientY),
																	) % max;
																const newAngle = moveEvent.shiftKey
																	? rawNewAngle
																	: Math.round(rawNewAngle / 45) * 45;

																if (
																	!moveEvent.shiftKey &&
																	hapticsEnabled &&
																	project.background.source.type ===
																		"gradient" &&
																	project.background.source.angle !== newAngle
																) {
																	commands.performHapticFeedback(
																		"alignment",
																		"now",
																	);
																}

																setProject("background", "source", {
																	type: "gradient",
																	angle:
																		newAngle < 0 ? newAngle + max : newAngle,
																});
															},
														}),
													);
												}}
											>
												<div class="bg-blue-9 rounded-full size-1.5" />
											</div>
										</div>
										<div class="flex flex-wrap gap-2">
											<For each={BACKGROUND_GRADIENTS}>
												{(gradient) => (
													<label class="relative">
														<input
															type="radio"
															class="sr-only peer"
															name="colorPicker"
															onChange={(e) => {
																if (e.target.checked) {
																	backgrounds.gradient = {
																		type: "gradient",
																		from: gradient.from,
																		to: gradient.to,
																	};
																	setProject(
																		"background",
																		"source",
																		backgrounds.gradient,
																	);
																}
															}}
														/>
														<div
															class="rounded-lg transition-all duration-200 cursor-pointer size-8 peer-checked:hover:opacity-100 peer-hover:opacity-70 peer-checked:ring-2 peer-checked:ring-gray-500 peer-checked:ring-offset-2 peer-checked:ring-offset-gray-200"
															style={{
																background: `linear-gradient(${angle()}deg, rgb(${gradient.from.join(
																	",",
																)}), rgb(${gradient.to.join(",")}))`,
															}}
														/>
													</label>
												)}
											</For>
										</div>
									</div>
								);
							}}
						</Show>
					</KTabs.Content>
				</KTabs>
			</Field>

			<Field name="Background Blur" icon={<IconCapBgBlur />}>
				<Slider
					value={[project.background.blur]}
					onChange={(v) => setProject("background", "blur", v[0])}
					minValue={0}
					maxValue={100}
					step={0.1}
					formatTooltip="%"
				/>
			</Field>
			{/** Dashed divider */}
			<div class="w-full border-t border-gray-300 border-dashed" />
			<Field name="Padding" icon={<IconCapPadding class="size-4" />}>
				<Slider
					value={[project.background.padding]}
					onChange={(v) => setProject("background", "padding", v[0])}
					minValue={0}
					maxValue={40}
					step={0.1}
					formatTooltip="%"
				/>
			</Field>
			<Field name="Rounded Corners" icon={<IconCapCorners class="size-4" />}>
				<div class="flex flex-col gap-3">
					<Slider
						value={[project.background.rounding]}
						onChange={(v) => setProject("background", "rounding", v[0])}
						minValue={0}
						maxValue={100}
						step={0.1}
						formatTooltip="%"
					/>
					<CornerStyleSelect
						label="Corner Style"
						value={project.background.roundingType}
						onChange={(value) =>
							setProject("background", "roundingType", value)
						}
					/>
				</div>
			</Field>
			<Field name="Motion Blur" icon={<IconLucideWind class="size-4" />}>
				<Slider
					value={[project.cursor.motionBlur ?? DEFAULT_CURSOR_MOTION_BLUR]}
					onChange={(v) => setProject("cursor", "motionBlur" as any, v[0])}
					minValue={0}
					maxValue={1}
					step={0.01}
					formatTooltip={(value) => `${Math.round(value * 100)}%`}
				/>
			</Field>
			<Field
				name="Border"
				icon={<IconCapSettings class="size-4" />}
				value={
					<Toggle
						checked={project.background.border?.enabled ?? false}
						onChange={(enabled) => {
							const prev = project.background.border ?? {
								enabled: false,
								width: 5.0,
								color: [0, 0, 0],
								opacity: 50.0,
							};

							if (props.scrollRef && enabled) {
								setTimeout(
									() =>
										props.scrollRef.scrollTo({
											top: props.scrollRef.scrollHeight,
											behavior: "smooth",
										}),
									100,
								);
							}

							setProject("background", "border", {
								...prev,
								enabled,
							});
						}}
					/>
				}
			/>
			<KCollapsible open={project.background.border?.enabled ?? false}>
				<KCollapsible.Content class="overflow-hidden opacity-0 transition-opacity animate-collapsible-up ui-expanded:animate-collapsible-down ui-expanded:opacity-100">
					<div class="flex flex-col gap-6 pb-6">
						<Field name="Border Width" icon={<IconCapEnlarge class="size-4" />}>
							<Slider
								value={[project.background.border?.width ?? 5.0]}
								onChange={(v) =>
									setProject("background", "border", {
										...(project.background.border ?? {
											enabled: true,
											width: 5.0,
											color: [0, 0, 0],
											opacity: 50.0,
										}),
										width: v[0],
									})
								}
								minValue={1}
								maxValue={20}
								step={0.1}
								formatTooltip="px"
							/>
						</Field>
						<Field name="Border Color" icon={<IconCapImage class="size-4" />}>
							<RgbInput
								value={project.background.border?.color ?? [0, 0, 0]}
								onChange={(color) =>
									setProject("background", "border", {
										...(project.background.border ?? {
											enabled: true,
											width: 5.0,
											color: [0, 0, 0],
											opacity: 50.0,
										}),
										color,
									})
								}
							/>
						</Field>
						<Field
							name="Border Opacity"
							icon={<IconCapShadow class="size-4" />}
						>
							<Slider
								value={[project.background.border?.opacity ?? 50.0]}
								onChange={(v) =>
									setProject("background", "border", {
										...(project.background.border ?? {
											enabled: true,
											width: 5.0,
											color: [0, 0, 0],
											opacity: 50.0,
										}),
										opacity: v[0],
									})
								}
								minValue={0}
								maxValue={100}
								step={0.1}
								formatTooltip="%"
							/>
						</Field>
					</div>
				</KCollapsible.Content>
			</KCollapsible>
			<Field name="Shadow" icon={<IconCapShadow class="size-4" />}>
				<Slider
					value={[project.background.shadow!]}
					onChange={(v) => {
						batch(() => {
							setProject("background", "shadow", v[0]);
							// Initialize advanced shadow settings if they don't exist and shadow is enabled
							if (v[0] > 0 && !project.background.advancedShadow) {
								setProject("background", "advancedShadow", {
									size: 50,
									opacity: 18,
									blur: 50,
								});
							}
						});
					}}
					minValue={0}
					maxValue={100}
					step={0.1}
					formatTooltip="%"
				/>

				<ShadowSettings
					scrollRef={props.scrollRef}
					size={{
						value: [project.background.advancedShadow?.size ?? 50],
						onChange: (v) => {
							setProject("background", "advancedShadow", {
								...(project.background.advancedShadow ?? {
									size: 50,
									opacity: 18,
									blur: 50,
								}),
								size: v[0],
							});
						},
					}}
					opacity={{
						value: [project.background.advancedShadow?.opacity ?? 18],
						onChange: (v) => {
							setProject("background", "advancedShadow", {
								...(project.background.advancedShadow ?? {
									size: 50,
									opacity: 18,
									blur: 50,
								}),
								opacity: v[0],
							});
						},
					}}
					blur={{
						value: [project.background.advancedShadow?.blur ?? 50],
						onChange: (v) => {
							setProject("background", "advancedShadow", {
								...(project.background.advancedShadow ?? {
									size: 50,
									opacity: 18,
									blur: 50,
								}),
								blur: v[0],
							});
						},
					}}
				/>
			</Field>
			{/* <ComingSoonTooltip>
            <Field name="Inset" icon={<IconCapInset />}>
              <Slider
                disabled
                value={[project.background.inset]}
                onChange={(v) => setProject("background", "inset", v[0])}
                minValue={0}
                maxValue={100}
              />
            </Field>
          </ComingSoonTooltip> */}
		</KTabs.Content>
	);
}

function CameraConfig(props: { scrollRef: HTMLDivElement }) {
	const { project, setProject } = useEditorContext();

	return (
		<KTabs.Content
			value={TAB_IDS.camera}
			class="flex flex-col flex-1 gap-6 p-4 min-h-0"
		>
			<Field icon={<IconCapCamera class="size-4" />} name="Camera">
				<div class="flex flex-col gap-6">
					<div>
						<Subfield name="Position" />
						<KRadioGroup
							value={`${project.camera.position.x}:${project.camera.position.y}`}
							onChange={(v) => {
								const [x, y] = v.split(":");
								setProject("camera", "position", { x, y } as any);
							}}
							class="mt-[0.75rem] rounded-[0.5rem] border border-gray-3 bg-gray-2 w-full h-[7.5rem] relative"
						>
							<For
								each={[
									{ x: "left", y: "top" } as const,
									{ x: "center", y: "top" } as const,
									{ x: "right", y: "top" } as const,
									{ x: "left", y: "bottom" } as const,
									{ x: "center", y: "bottom" } as const,
									{ x: "right", y: "bottom" } as const,
								]}
							>
								{(item) => (
									<RadioGroup.Item value={`${item.x}:${item.y}`}>
										<RadioGroup.ItemInput class="peer" />
										<RadioGroup.ItemControl
											class={cx(
												"cursor-pointer size-6 shrink-0 rounded-[0.375rem] bg-gray-5 absolute flex justify-center items-center ui-checked:bg-blue-9 focus-visible:outline peer-focus-visible:outline outline-2 outline-blue-9 outline-offset-2 transition-colors duration-100",
												item.x === "left"
													? "left-2"
													: item.x === "right"
														? "right-2"
														: "left-1/2 transform -translate-x-1/2",
												item.y === "top" ? "top-2" : "bottom-2",
											)}
										>
											<div class="size-[0.5rem] shrink-0 bg-solid-white rounded-full" />
										</RadioGroup.ItemControl>
									</RadioGroup.Item>
								)}
							</For>
						</KRadioGroup>
					</div>
					<Subfield name="Hide Camera">
						<Toggle
							checked={project.camera.hide}
							onChange={(hide) => setProject("camera", "hide", hide)}
						/>
					</Subfield>
					<Subfield name="Mirror Camera">
						<Toggle
							checked={project.camera.mirror}
							onChange={(mirror) => setProject("camera", "mirror", mirror)}
						/>
					</Subfield>
					<Subfield name="Shape">
						<KSelect<{ name: string; value: CameraShape }>
							options={CAMERA_SHAPES}
							optionValue="value"
							optionTextValue="name"
							value={CAMERA_SHAPES.find(
								(v) => v.value === project.camera.shape,
							)}
							onChange={(v) => {
								if (v) setProject("camera", "shape", v.value);
							}}
							disallowEmptySelection
							itemComponent={(props) => (
								<MenuItem<typeof KSelect.Item>
									as={KSelect.Item}
									item={props.item}
								>
									<KSelect.ItemLabel class="flex-1">
										{props.item.rawValue.name}
									</KSelect.ItemLabel>
								</MenuItem>
							)}
						>
							<KSelect.Trigger class="flex flex-row gap-2 items-center px-2 w-full h-8 rounded-lg transition-colors bg-gray-3 disabled:text-gray-11">
								<KSelect.Value<{
									name: string;
									value: StereoMode;
								}> class="flex-1 text-sm text-left truncate text-[--gray-500] font-normal">
									{(state) => <span>{state.selectedOption().name}</span>}
								</KSelect.Value>
								<KSelect.Icon<ValidComponent>
									as={(props) => (
										<IconCapChevronDown
											{...props}
											class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180 text-[--gray-500]"
										/>
									)}
								/>
							</KSelect.Trigger>
							<KSelect.Portal>
								<PopperContent<typeof KSelect.Content>
									as={KSelect.Content}
									class={cx(topSlideAnimateClasses, "z-50")}
								>
									<MenuItemList<typeof KSelect.Listbox>
										class="overflow-y-auto max-h-32"
										as={KSelect.Listbox}
									/>
								</PopperContent>
							</KSelect.Portal>
						</KSelect>
					</Subfield>

					{/* <Subfield name="Use Camera Aspect Ratio">
            <Toggle
              checked={project.camera.use_camera_aspect}
              onChange={(v) => setProject("camera", "use_camera_aspect", v)}
            />
          </Subfield> */}
				</div>
			</Field>
			{/** Dashed divider */}
			<div class="w-full border-t border-dashed border-gray-5" />
			<Field name="Size" icon={<IconCapEnlarge class="size-4" />}>
				<Slider
					value={[project.camera.size]}
					onChange={(v) => setProject("camera", "size", v[0])}
					minValue={20}
					maxValue={80}
					step={0.1}
					formatTooltip="%"
				/>
			</Field>
			<Field name="Size During Zoom" icon={<IconCapEnlarge class="size-4" />}>
				<Slider
					value={[project.camera.zoomSize ?? 60]}
					onChange={(v) => setProject("camera", "zoomSize", v[0])}
					minValue={10}
					maxValue={60}
					step={0.1}
					formatTooltip="%"
				/>
			</Field>
			<Field name="Rounded Corners" icon={<IconCapCorners class="size-4" />}>
				<div class="flex flex-col gap-3">
					<Slider
						value={[project.camera.rounding!]}
						onChange={(v) => setProject("camera", "rounding", v[0])}
						minValue={0}
						maxValue={100}
						step={0.1}
						formatTooltip="%"
					/>
					<CornerStyleSelect
						label="Corner Style"
						value={project.camera.roundingType}
						onChange={(value) => setProject("camera", "roundingType", value)}
					/>
				</div>
			</Field>
			<Field name="Shadow" icon={<IconCapShadow class="size-4" />}>
				<div class="space-y-8">
					<Slider
						value={[project.camera.shadow!]}
						onChange={(v) => setProject("camera", "shadow", v[0])}
						minValue={0}
						maxValue={100}
						step={0.1}
						formatTooltip="%"
					/>
					<ShadowSettings
						scrollRef={props.scrollRef}
						size={{
							value: [project.camera.advancedShadow?.size ?? 50],
							onChange: (v) => {
								setProject("camera", "advancedShadow", {
									...(project.camera.advancedShadow ?? {
										size: 50,
										opacity: 18,
										blur: 50,
									}),
									size: v[0],
								});
							},
						}}
						opacity={{
							value: [project.camera.advancedShadow?.opacity ?? 18],
							onChange: (v) => {
								setProject("camera", "advancedShadow", {
									...(project.camera.advancedShadow ?? {
										size: 50,
										opacity: 18,
										blur: 50,
									}),
									opacity: v[0],
								});
							},
						}}
						blur={{
							value: [project.camera.advancedShadow?.blur ?? 50],
							onChange: (v) => {
								setProject("camera", "advancedShadow", {
									...(project.camera.advancedShadow ?? {
										size: 50,
										opacity: 18,
										blur: 50,
									}),
									blur: v[0],
								});
							},
						}}
					/>
				</div>
			</Field>
			{/* <ComingSoonTooltip>
            <Field name="Shadow" icon={<IconCapShadow />}>
              <Slider
                disabled
                value={[project.camera.shadow]}
                onChange={(v) => setProject("camera", "shadow", v[0])}
                minValue={0}
                maxValue={100}
              />
            </Field>
          </ComingSoonTooltip> */}
		</KTabs.Content>
	);
}

function CornerStyleSelect(props: {
	label?: string;
	value: CornerRoundingType;
	onChange: (value: CornerRoundingType) => void;
}) {
	return (
		<div class="flex flex-col gap-1.5">
			<Show when={props.label}>
				{(label) => (
					<span class="text-[0.65rem] uppercase tracking-wide text-gray-11">
						{label()}
					</span>
				)}
			</Show>
			<KSelect<{ name: string; value: CornerRoundingType }>
				options={CORNER_STYLE_OPTIONS}
				optionValue="value"
				optionTextValue="name"
				value={CORNER_STYLE_OPTIONS.find(
					(option) => option.value === props.value,
				)}
				onChange={(option) => option && props.onChange(option.value)}
				disallowEmptySelection
				itemComponent={(itemProps) => (
					<MenuItem<typeof KSelect.Item>
						as={KSelect.Item}
						item={itemProps.item}
					>
						<KSelect.ItemLabel class="flex-1">
							{itemProps.item.rawValue.name}
						</KSelect.ItemLabel>
					</MenuItem>
				)}
			>
				<KSelect.Trigger class="flex flex-row gap-2 items-center px-2 w-full h-8 rounded-lg transition-colors bg-gray-3 disabled:text-gray-11">
					<KSelect.Value<{
						name: string;
						value: CornerRoundingType;
					}> class="flex-1 text-sm text-left truncate text-[--gray-500] font-normal">
						{(state) => <span>{state.selectedOption().name}</span>}
					</KSelect.Value>
					<KSelect.Icon<ValidComponent>
						as={(iconProps) => (
							<IconCapChevronDown
								{...iconProps}
								class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180 text-[--gray-500]"
							/>
						)}
					/>
				</KSelect.Trigger>
				<KSelect.Portal>
					<PopperContent<typeof KSelect.Content>
						as={KSelect.Content}
						class={cx(topSlideAnimateClasses, "z-50")}
					>
						<MenuItemList<typeof KSelect.Listbox>
							class="overflow-y-auto max-h-32"
							as={KSelect.Listbox}
						/>
					</PopperContent>
				</KSelect.Portal>
			</KSelect>
		</div>
	);
}

const normalizeHexInput = (value: string, fallback: string) => {
	const trimmed = value.trim();
	const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
	const shortMatch = /^#[0-9A-Fa-f]{3}$/.test(withHash);
	if (shortMatch) {
		const [, r, g, b] = withHash;
		return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
	}
	const fullMatch = /^#[0-9A-Fa-f]{6}$/.test(withHash);
	if (fullMatch) return withHash.toLowerCase();
	return fallback;
};

function HexColorInput(props: {
	value: string;
	onChange: (value: string) => void;
}) {
	const [text, setText] = createWritableMemo(() => props.value);
	let prevColor = props.value;
	let colorInput: HTMLInputElement | undefined;

	return (
		<div class="flex items-center gap-3">
			<div class="relative">
				<button
					type="button"
					class="w-10 h-10 rounded-md border border-gray-4 cursor-pointer hover:border-gray-5 transition-colors"
					style={{ "background-color": text() }}
					onClick={() => colorInput?.click()}
				/>
				<input
					ref={(el) => {
						colorInput = el;
					}}
					type="color"
					class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
					value={text()}
					onInput={(e) => {
						const next = e.currentTarget.value;
						setText(next);
						prevColor = next;
						props.onChange(next);
					}}
				/>
			</div>
			<TextInput
				class="flex-1 px-3 py-2 rounded-lg border border-gray-3 bg-gray-2 text-sm text-gray-12"
				value={text()}
				onFocus={() => {
					prevColor = props.value;
				}}
				onInput={(e) => {
					setText(e.currentTarget.value);
				}}
				onBlur={(e) => {
					const next = normalizeHexInput(e.currentTarget.value, prevColor);
					setText(next);
					prevColor = next;
					props.onChange(next);
				}}
			/>
		</div>
	);
}

function TextSegmentConfig(props: {
	segmentIndex: number;
	segment: TextSegment;
}) {
	const { setProject } = useEditorContext();
	const clampNumber = (value: number, min: number, max: number) =>
		Math.min(Math.max(Number.isFinite(value) ? value : min), max);

	const updateSegment = (fn: (segment: TextSegment) => void) => {
		setProject(
			"timeline",
			"textSegments",
			produce((segments) => {
				const target = segments?.[props.segmentIndex];
				if (!target) return;
				fn(target);
			}),
		);
	};

	return (
		<div class="space-y-4">
			<Field
				name={`Text ${props.segmentIndex + 1}`}
				icon={<IconLucideType class="size-4" />}
			>
				<div class="flex items-center gap-3">
					<textarea
						class="flex-1 px-3 py-2 rounded-lg border border-gray-3 bg-gray-2 text-gray-12 resize-none min-h-[80px]"
						value={props.segment.content}
						onInput={(e) =>
							updateSegment((segment) => {
								segment.content = e.currentTarget.value;
							})
						}
					/>
					<div class="flex flex-col items-center gap-2">
						<span class="text-xs text-gray-11">Enabled</span>
						<Toggle
							checked={props.segment.enabled}
							onChange={(value) =>
								updateSegment((segment) => {
									segment.enabled = value;
								})
							}
						/>
					</div>
				</div>
			</Field>
			<Field name="Size" icon={<IconCapEnlarge class="size-4" />}>
				<Slider
					value={[clampNumber(props.segment.fontSize, 8, 200)]}
					onChange={([value]) =>
						updateSegment((segment) => {
							const newFontSize = clampNumber(value, 8, 200);
							const oldFontSize = segment.fontSize || 48;
							const scale = newFontSize / oldFontSize;

							segment.fontSize = newFontSize;

							if (
								segment.size &&
								segment.size.x > 0.025 &&
								segment.size.y > 0.025
							) {
								const maxSize = 0.95;
								segment.size.x = Math.min(segment.size.x * scale, maxSize);
								segment.size.y = Math.min(segment.size.y * scale, maxSize);
							}
						})
					}
					minValue={8}
					maxValue={200}
					step={1}
				/>
			</Field>
			<Field name="Style" icon={<IconLucideSparkles class="size-4" />}>
				<div class="flex flex-col gap-2">
					<KSelect
						options={[
							{ label: "Normal", value: 400 },
							{ label: "Medium", value: 500 },
							{ label: "Bold", value: 700 },
						]}
						optionValue="value"
						optionTextValue="label"
						value={{
							label: "Custom",
							value: props.segment.fontWeight,
						}}
						onChange={(value) => {
							if (!value) return;
							updateSegment((segment) => {
								segment.fontWeight = value.value;
							});
						}}
						itemComponent={(selectItemProps) => (
							<MenuItem<typeof KSelect.Item>
								as={KSelect.Item}
								item={selectItemProps.item}
							>
								<KSelect.ItemLabel class="flex-1">
									{selectItemProps.item.rawValue.label}
								</KSelect.ItemLabel>
								<KSelect.ItemIndicator class="ml-auto text-blue-9">
									<IconCapCircleCheck />
								</KSelect.ItemIndicator>
							</MenuItem>
						)}
					>
						<KSelect.Trigger class="flex w-full items-center justify-between rounded-md border border-gray-3 bg-gray-2 px-3 py-2 text-sm text-gray-12 transition-colors hover:border-gray-4 hover:bg-gray-3 focus:border-blue-9 focus:outline-none focus:ring-1 focus:ring-blue-9">
							<KSelect.Value<any> class="truncate">
								{(state) => {
									const selected = state.selectedOption();
									if (selected) return selected.label;
									const weight = props.segment.fontWeight;
									const option = [
										{ label: "Normal", value: 400 },
										{ label: "Medium", value: 500 },
										{ label: "Bold", value: 700 },
									].find((o) => o.value === weight);
									if (option) return option.label;
									if (weight != null) return `Custom (${weight})`;
									return "Normal";
								}}
							</KSelect.Value>
							<KSelect.Icon>
								<IconCapChevronDown class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180 text-[--gray-500]" />
							</KSelect.Icon>
						</KSelect.Trigger>
						<KSelect.Portal>
							<PopperContent<typeof KSelect.Content>
								as={KSelect.Content}
								class={cx(topSlideAnimateClasses, "z-50")}
							>
								<MenuItemList<typeof KSelect.Listbox>
									class="overflow-y-auto max-h-40"
									as={KSelect.Listbox}
								/>
							</PopperContent>
						</KSelect.Portal>
					</KSelect>

					<div class="flex items-center justify-between pt-1">
						<span class="text-xs text-gray-11">Italic</span>
						<Toggle
							checked={props.segment.italic}
							onChange={(value) =>
								updateSegment((segment) => {
									segment.italic = value;
								})
							}
						/>
					</div>
				</div>
			</Field>
			<Field name="Color" icon={<IconLucidePalette class="size-4" />}>
				<HexColorInput
					value={props.segment.color}
					onChange={(value) =>
						updateSegment((segment) => {
							segment.color = value;
						})
					}
				/>
			</Field>
			<Field name="Fade Duration" icon={<IconLucideTimer class="size-4" />}>
				<Slider
					value={[clampNumber(props.segment.fadeDuration ?? 0.15, 0, 1)]}
					onChange={([value]) =>
						updateSegment((segment) => {
							segment.fadeDuration = clampNumber(value, 0, 1);
						})
					}
					minValue={0}
					maxValue={1}
					step={0.01}
					formatTooltip="s"
				/>
			</Field>
		</div>
	);
}

function MaskSegmentConfig(props: {
	segmentIndex: number;
	segment: MaskSegment;
}) {
	const { setProject, editorState } = useEditorContext();

	const updateSegment = (fn: (segment: MaskSegment) => void) => {
		setProject(
			"timeline",
			"maskSegments",
			produce((segments) => {
				const target = segments?.[props.segmentIndex];
				if (!target) return;
				target.keyframes ??= { position: [], size: [], intensity: [] };
				fn(target);
			}),
		);
	};

	createEffect(() => {
		const keyframes = props.segment.keyframes;
		if (
			!keyframes ||
			(keyframes.position.length === 0 &&
				keyframes.size.length === 0 &&
				keyframes.intensity.length === 0)
		)
			return;
		updateSegment((segment) => {
			segment.keyframes = { position: [], size: [], intensity: [] };
		});
	});

	const currentAbsoluteTime = () =>
		editorState.previewTime ?? editorState.playbackTime ?? props.segment.start;
	const _maskState = () => evaluateMask(props.segment, currentAbsoluteTime());

	const clearKeyframes = (segment: MaskSegment) => {
		segment.keyframes.position = [];
		segment.keyframes.size = [];
		segment.keyframes.intensity = [];
	};

	const _setPosition = (value: { x: number; y: number }) =>
		updateSegment((segment) => {
			segment.center = value;
			clearKeyframes(segment);
		});

	const _setSize = (value: { x: number; y: number }) =>
		updateSegment((segment) => {
			segment.size = value;
			clearKeyframes(segment);
		});

	const setIntensity = (value: number) =>
		updateSegment((segment) => {
			segment.opacity = value;
			clearKeyframes(segment);
		});

	return (
		<div class="space-y-4">
			<Field
				name={`Mask ${props.segmentIndex + 1}`}
				icon={<IconLucideBoxSelect class="size-4" />}
			>
				<div class="flex items-center justify-between gap-4">
					<RadioGroup
						class="grid grid-cols-2 gap-2"
						value={props.segment.maskType}
						onChange={(value) =>
							updateSegment((segment) => {
								segment.maskType = value as MaskKind;
								if (segment.maskType === "highlight") {
									segment.feather = 0;
									segment.opacity = 1;
								} else {
									segment.feather = 0.1;
								}
							})
						}
					>
						{[
							{ value: "sensitive", label: "Sensitive" },
							{ value: "highlight", label: "Highlight" },
						].map((option) => (
							<RadioGroup.Item
								value={option.value}
								class="rounded-lg border border-gray-3 transition-colors ui-checked:border-blue-8 ui-checked:bg-blue-3/40"
							>
								<RadioGroup.ItemInput class="sr-only" />
								<RadioGroup.ItemLabel class="flex cursor-pointer items-center gap-2 p-2 text-sm text-gray-12">
									<RadioGroup.ItemControl class="size-4 rounded-full border border-gray-7 ui-checked:border-blue-9 ui-checked:bg-blue-9" />
									{option.label}
								</RadioGroup.ItemLabel>
							</RadioGroup.Item>
						))}
					</RadioGroup>
					<div class="flex items-center gap-2">
						<span class="text-xs text-gray-11">Enabled</span>
						<Toggle
							checked={props.segment.enabled}
							onChange={(value) =>
								updateSegment((segment) => {
									segment.enabled = value;
								})
							}
						/>
					</div>
				</div>
			</Field>
			<Show when={props.segment.maskType === "sensitive"}>
				<Field name="Intensity" icon={<IconLucideGauge class="size-4" />}>
					<Slider
						value={[props.segment.opacity]}
						onChange={([v]) => setIntensity(v)}
						minValue={0}
						maxValue={1}
						step={0.01}
						formatTooltip="%"
					/>
				</Field>
			</Show>
			<Show when={props.segment.maskType === "sensitive"}>
				<Field name="Pixelation" icon={<IconLucideGrid class="size-4" />}>
					<Slider
						value={[props.segment.pixelation]}
						onChange={([v]) =>
							updateSegment((segment) => {
								segment.pixelation = v;
							})
						}
						minValue={1}
						maxValue={80}
						step={1}
					/>
				</Field>
			</Show>
			<Show when={props.segment.maskType === "highlight"}>
				<Field name="Outside Darkness" icon={<IconLucideMoon class="size-4" />}>
					<Slider
						value={[props.segment.darkness]}
						onChange={([v]) =>
							updateSegment((segment) => {
								segment.darkness = v;
							})
						}
						minValue={0}
						maxValue={1}
						step={0.01}
					/>
				</Field>
			</Show>
			<Field name="Fade Duration" icon={<IconLucideTimer class="size-4" />}>
				<Slider
					value={[props.segment.fadeDuration ?? 0.15]}
					onChange={([v]) =>
						updateSegment((segment) => {
							segment.fadeDuration = v;
						})
					}
					minValue={0}
					maxValue={1}
					step={0.01}
					formatTooltip="s"
				/>
			</Field>
		</div>
	);
}

function ZoomSegmentPreview(props: {
	segmentIndex: number;
	segment: ZoomSegment;
}) {
	const { project, editorInstance } = useEditorContext();

	const start = createMemo(() => props.segment.start);

	const clipSegment = createMemo(() => {
		const st = start();
		return project.timeline?.segments.find((s) => s.start <= st && s.end > st);
	});

	const relativeTime = createMemo(() => {
		const st = start();
		const segment = clipSegment();
		if (!segment) return 0;
		return Math.max(0, st - segment.start);
	});

	const video = document.createElement("video");
	createEffect(() => {
		// TODO: make this not hardcoded
		const path = convertFileSrc(
			`${editorInstance.path}/content/segments/segment-${
				clipSegment()?.recordingSegment ?? 0
			}/display.mp4`,
		);
		video.src = path;
		video.preload = "auto";
		video.load();
	});

	createEffect(() => {
		const t = relativeTime();
		if (t === undefined) return;

		if (video.readyState >= 2) {
			video.currentTime = t;
		} else {
			const handleCanPlay = () => {
				video.currentTime = t;
				video.removeEventListener("canplay", handleCanPlay);
			};
			video.addEventListener("canplay", handleCanPlay);
		}
	});

	const render = () => {
		if (!canvasRef || video.readyState < 2) return;

		const ctx = canvasRef.getContext("2d");
		if (!ctx) return;

		ctx.imageSmoothingEnabled = false;
		ctx.clearRect(0, 0, canvasRef.width, canvasRef.height);

		const raw = editorInstance.recordings.segments[0].display;
		const croppedPosition = project.background.crop?.position || { x: 0, y: 0 };
		const croppedSize = project.background.crop?.size || {
			x: raw.width,
			y: raw.height,
		};

		ctx.drawImage(
			video,
			croppedPosition.x,
			croppedPosition.y,
			croppedSize.x,
			croppedSize.y,
			0,
			0,
			canvasRef.width,
			canvasRef.height,
		);
	};

	const [loaded, setLoaded] = createSignal(false);
	video.onloadeddata = () => {
		setLoaded(true);
		render();
	};
	video.onseeked = render;
	video.onerror = () => {
		setTimeout(() => video.load(), 100);
	};

	let canvasRef!: HTMLCanvasElement;

	return (
		<>
			<div class="space-y-1.5">
				<div class="text-xs font-medium text-center text-gray-12">
					Zoom {props.segmentIndex + 1}
				</div>
				<div class="overflow-hidden relative rounded border aspect-video border-gray-3 bg-gray-3">
					<canvas
						ref={canvasRef}
						width={160}
						height={90}
						data-loaded={loaded()}
						class="w-full h-full opacity-0 transition-opacity data-[loaded='true']:opacity-100 duration-200"
					/>
					<Show when={!loaded()}>
						<p class="flex absolute inset-0 justify-center items-center text-xs text-gray-11">
							Loading...
						</p>
					</Show>
				</div>
			</div>
			<div class="flex gap-1 justify-center items-center mt-3 w-full text-xs text-center text-gray-11">
				<IconLucideSearch class="size-3" />
				<p>{props.segment.amount.toFixed(1)}x</p>
			</div>
		</>
	);
}

function ZoomSegmentConfig(props: {
	segmentIndex: number;
	segment: ZoomSegment;
}) {
	const generalSettings = generalSettingsStore.createQuery();
	const {
		project,
		setProject,
		editorInstance,
		setEditorState,
		projectHistory,
	} = useEditorContext();

	const states = {
		manual:
			props.segment.mode === "auto"
				? { x: 0.5, y: 0.5 }
				: props.segment.mode.manual,
	};

	return (
		<>
			<Field
				name={`Zoom ${props.segmentIndex + 1}`}
				icon={<IconLucideSearch />}
			>
				<Slider
					value={[props.segment.amount]}
					onChange={(v) =>
						setProject(
							"timeline",
							"zoomSegments",
							props.segmentIndex,
							"amount",
							v[0],
						)
					}
					minValue={1}
					maxValue={4.5}
					step={0.001}
					formatTooltip="x"
				/>
			</Field>
			<Field name="Zoom Mode" icon={<IconCapSettings />}>
				<KTabs
					class="space-y-6"
					value={props.segment.mode === "auto" ? "auto" : "manual"}
					onChange={(v) => {
						setProject(
							"timeline",
							"zoomSegments",
							props.segmentIndex,
							"mode",
							v === "auto" ? "auto" : { manual: states.manual },
						);
					}}
				>
					<KTabs.List class="flex flex-row items-center rounded-[0.5rem] relative border">
						<KTabs.Trigger
							value="auto"
							class="z-10 flex-1 py-2.5 text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-12 peer"
							disabled={!generalSettings.data?.custom_cursor_capture2}
						>
							Auto
						</KTabs.Trigger>
						<KTabs.Trigger
							value="manual"
							class="z-10 flex-1 py-2.5 text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-12 peer"
						>
							Manual
						</KTabs.Trigger>
						<KTabs.Indicator class="absolute flex p-px inset-0 transition-transform peer-focus-visible:outline outline-2 outline-blue-9 outline-offset-2 rounded-[0.6rem] overflow-hidden">
							<div class="flex-1 bg-gray-3" />
						</KTabs.Indicator>
					</KTabs.List>
					<KTabs.Content value="manual" tabIndex="">
						<Show
							when={(() => {
								const m = props.segment.mode;
								if (m === "auto") return;

								return m.manual;
							})()}
						>
							{(mode) => {
								const start = createMemo<number>((prev) => {
									if (projectHistory.isPaused()) return prev;

									return props.segment.start;
								}, 0);

								const segmentIndex = createMemo<number>((prev) => {
									if (projectHistory.isPaused()) return prev;

									const st = start();
									const i = project.timeline?.segments.findIndex(
										(s) => s.start <= st && s.end > st,
									);
									if (i === undefined || i === -1) return 0;
									return i;
								}, 0);

								// Calculate the time relative to the video segment
								const relativeTime = createMemo(() => {
									const st = start();
									const segment = project.timeline?.segments[segmentIndex()];
									if (!segment) return 0;
									// The time within the actual video file
									return Math.max(0, st - segment.start);
								});

								const video = document.createElement("video");
								createEffect(() => {
									const path = convertFileSrc(
										// TODO: this shouldn't be so hardcoded
										`${
											editorInstance.path
										}/content/segments/segment-${segmentIndex()}/display.mp4`,
									);
									video.src = path;
									video.preload = "auto";
									// Force reload if video fails to load
									video.load();
								});

								createEffect(() => {
									const t = relativeTime();
									if (t === undefined) return;

									// Ensure video is ready before seeking
									if (video.readyState >= 2) {
										video.currentTime = t;
									} else {
										// Wait for video to be ready, then seek
										const handleCanPlay = () => {
											video.currentTime = t;
											video.removeEventListener("canplay", handleCanPlay);
										};
										video.addEventListener("canplay", handleCanPlay);
									}
								});

								createEffect(
									on(
										() => {
											croppedPosition();
											croppedSize();
										},
										() => {
											if (loaded()) {
												render();
											}
										},
									),
								);

								const render = () => {
									if (!canvasRef || video.readyState < 2) return;

									const ctx = canvasRef.getContext("2d");
									if (!ctx) return;

									ctx.imageSmoothingEnabled = false;
									// Clear canvas first
									ctx.clearRect(0, 0, canvasRef.width, canvasRef.height);
									// Draw video frame
									ctx.drawImage(
										video,
										croppedPosition().x,
										croppedPosition().y,
										croppedSize().x,
										croppedSize().y,
										0,
										0,
										canvasRef.width!,
										canvasRef.height!,
									);
								};

								const [loaded, setLoaded] = createSignal(false);
								video.onloadeddata = () => {
									setLoaded(true);
									render();
								};
								video.onseeked = render;

								// Add error handling
								video.onerror = (e) => {
									console.error("Failed to load video for zoom preview:", e);
									// Try to reload after a short delay
									setTimeout(() => {
										video.load();
									}, 100);
								};

								let canvasRef!: HTMLCanvasElement;

								const [ref, setRef] = createSignal<HTMLDivElement>();
								const bounds = createElementBounds(ref);
								const rawSize = () => {
									const raw = editorInstance.recordings.segments[0].display;
									return { x: raw.width, y: raw.height };
								};

								const croppedPosition = () => {
									const cropped = project.background.crop?.position;
									if (cropped) return cropped;

									return { x: 0, y: 0 };
								};

								const croppedSize = () => {
									const cropped = project.background.crop?.size;
									if (cropped) return cropped;

									return rawSize();
								};

								const visualHeight = () =>
									(bounds.width! / croppedSize().x) * croppedSize().y;

								return (
									<div
										ref={setRef}
										class="relative w-full"
										style={{
											height: `calc(${visualHeight()}px + 0.25rem)`,
										}}
										onMouseDown={(downEvent) => {
											const bounds =
												downEvent.currentTarget.getBoundingClientRect();

											createRoot((dispose) =>
												createEventListenerMap(window, {
													mouseup: () => dispose(),
													mousemove: (moveEvent) => {
														setProject(
															"timeline",
															"zoomSegments",
															props.segmentIndex,
															"mode",
															"manual",
															{
																x: Math.max(
																	Math.min(
																		(moveEvent.clientX - bounds.left) /
																			bounds.width,
																		1,
																	),
																	0,
																),
																y: Math.max(
																	Math.min(
																		(moveEvent.clientY - bounds.top) /
																			bounds.height,
																		1,
																	),
																	0,
																),
															},
														);
													},
												}),
											);
										}}
									>
										<div
											class="absolute z-10 w-6 h-6 rounded-full border border-gray-400 -translate-x-1/2 -translate-y-1/2 bg-gray-1"
											style={{
												left: `${mode().x * 100}%`,
												top: `${mode().y * 100}%`,
											}}
										>
											<div class="size-1.5 bg-gray-5 rounded-full" />
										</div>
										<div class="overflow-hidden relative rounded-lg border border-gray-3 bg-gray-2">
											<canvas
												ref={canvasRef}
												width={croppedSize().x}
												height={croppedSize().y}
												data-loaded={loaded()}
												class="z-10 bg-gray-3 opacity-0 transition-opacity data-[loaded='true']:opacity-100 w-full h-full duration-200"
											/>
											<Show when={!loaded()}>
												<div class="flex absolute inset-0 justify-center items-center bg-gray-2">
													<div class="text-sm text-gray-11">
														Loading preview...
													</div>
												</div>
											</Show>
										</div>
									</div>
								);
							}}
						</Show>
					</KTabs.Content>
				</KTabs>
			</Field>
		</>
	);
}

function ClipSegmentConfig(props: {
	segmentIndex: number;
	segment: TimelineSegment;
}) {
	const { setProject, setEditorState, project, projectActions, meta } =
		useEditorContext();

	// Get current clip configuration
	const clipConfig = () =>
		project.clips?.find((c) => c.index === props.segmentIndex);
	const offsets = () => clipConfig()?.offsets || {};

	function setOffset(type: keyof ClipOffsets, offset: number) {
		if (Number.isNaN(offset)) return;

		setProject(
			produce((proj) => {
				const clips = (proj.clips ??= []);
				let clip = clips.find(
					(clip) => clip.index === (props.segment.recordingSegment ?? 0),
				);
				if (!clip) {
					clip = { index: 0, offsets: {} };
					clips.push(clip);
				}

				clip.offsets[type] = offset / 1000;
			}),
		);
	}

	return (
		<>
			<div class="flex flex-row justify-between items-center">
				<div class="flex gap-2 items-center">
					<EditorButton
						onClick={() => setEditorState("timeline", "selection", null)}
						leftIcon={<IconLucideCheck />}
					>
						Done
					</EditorButton>
				</div>
				<EditorButton
					variant="danger"
					onClick={() => {
						projectActions.deleteClipSegment(props.segmentIndex);
					}}
					disabled={
						(
							project.timeline?.segments.filter(
								(s) => s.recordingSegment === props.segment.recordingSegment,
							) ?? []
						).length < 2
					}
					leftIcon={<IconCapTrash />}
				>
					Delete
				</EditorButton>
			</div>

			<div class="space-y-0.5">
				<h3 class="font-medium text-gray-12">Segment Settings</h3>
				<p class="text-gray-11">
					These settings apply to only the selected segment
				</p>
			</div>

			<Field name="Speed" icon={<IconLucideFastForward class="size-4" />}>
				<p class="text-gray-11 -mt-3">
					Modifying speed will mute this segment's audio.
				</p>

				<KRadioGroup
					class="flex flex-row gap-1.5 -mt-1"
					value={props.segment.timescale.toString()}
					onChange={(v) => {
						projectActions.setClipSegmentTimescale(
							props.segmentIndex,
							parseFloat(v),
						);
					}}
				>
					<For each={[0.25, 0.5, 1, 1.5, 2, 4, 8]}>
						{(mult) => (
							<KRadioGroup.Item value={mult.toString()}>
								<KRadioGroup.ItemControl class="px-2 py-1 text-gray-11 hover:text-gray-12 bg-gray-1 border border-gray-3 rounded-md ui-checked:bg-gray-3 ui-checked:border-gray-4 ui-checked:text-gray-12">
									{mult}x
								</KRadioGroup.ItemControl>
							</KRadioGroup.Item>
						)}
					</For>
				</KRadioGroup>
			</Field>

			<div class="space-y-0.5 pt-2">
				<h3 class="font-medium text-gray-12">Clip Settings</h3>
				<p class="text-gray-11">
					These settings apply to all segments for the current clip
				</p>
			</div>

			{meta().hasSystemAudio && (
				<SourceOffsetField
					name="System Audio Offset"
					value={offsets().system_audio}
					onChange={(offset) => {
						setOffset("system_audio", offset);
					}}
				/>
			)}
			{meta().hasMicrophone && (
				<SourceOffsetField
					name="Microphone Offset"
					value={offsets().mic}
					onChange={(offset) => {
						setOffset("mic", offset);
					}}
				/>
			)}
			{meta().hasCamera && (
				<SourceOffsetField
					name="Camera Offset"
					value={offsets().camera}
					onChange={(offset) => {
						setOffset("camera", offset);
					}}
				/>
			)}

			{/*<ComingSoonTooltip>
			<Field name="Hide Cursor" disabled value={<Toggle disabled />} />
		</ComingSoonTooltip>
		<ComingSoonTooltip>
			<Field
				name="Disable Smooth Cursor Movement"
				disabled
				value={<Toggle disabled />}
			/>
		</ComingSoonTooltip>*/}
		</>
	);
}

function SourceOffsetField(props: {
	name: string;
	// seconds
	value?: number;
	onChange: (value: number) => void;
}) {
	const rawValue = () => Math.round((props.value ?? 0) * 1000);

	const [value, setValue] = createSignal(rawValue().toString());

	return (
		<Field name={props.name}>
			<div class="flex flex-row justify-between items-center -mt-2 w-full">
				<div class="flex flex-row items-end space-x-1">
					<NumberField.Root
						value={value()}
						onChange={setValue}
						rawValue={rawValue()}
						onRawValueChange={(v) => {
							props.onChange(v);
						}}
					>
						<NumberField.Input
							onBlur={() => {
								if (!rawValue() || value() === "" || Number.isNaN(rawValue())) {
									setValue("0");
									props.onChange(0);
								}
							}}
							class="w-[5rem] p-[0.375rem] border rounded-[0.5rem] bg-gray-1 focus-visible:outline-none"
						/>
					</NumberField.Root>
					<span class="text-gray-11">ms</span>
				</div>
				<div class="flex flex-row space-x-1 text-gray-11">
					{[-100, -10, 10, 100].map((v) => (
						<button
							type="button"
							onClick={() => {
								const currentValue = rawValue() + v;
								props.onChange(currentValue);
								setValue(currentValue.toString());
							}}
							class="text-gray-11 hover:text-gray-12 text-xs px-1 py-0.5 bg-gray-1 border border-gray-3 rounded"
						>
							{Math.sign(v) > 0 ? "+" : "-"}
							{Math.abs(v)}ms
						</button>
					))}
				</div>
			</div>
		</Field>
	);
}

function SceneSegmentConfig(props: {
	segmentIndex: number;
	segment: SceneSegment;
}) {
	const { setProject, setEditorState, projectActions } = useEditorContext();

	return (
		<>
			<div class="flex flex-row justify-between items-center">
				<div class="flex gap-2 items-center">
					<EditorButton
						onClick={() => setEditorState("timeline", "selection", null)}
						leftIcon={<IconLucideCheck />}
					>
						Done
					</EditorButton>
				</div>
				<EditorButton
					variant="danger"
					onClick={() => {
						projectActions.deleteSceneSegment(props.segmentIndex);
					}}
					leftIcon={<IconCapTrash />}
				>
					Delete
				</EditorButton>
			</div>
			<Field name="Camera Layout" icon={<IconLucideLayout />}>
				<KTabs
					class="space-y-6"
					value={props.segment.mode || "default"}
					onChange={(v) => {
						setProject(
							"timeline",
							"sceneSegments",
							props.segmentIndex,
							"mode",
							v as "default" | "cameraOnly" | "hideCamera",
						);
					}}
				>
					<KTabs.List class="flex flex-col gap-3">
						<div class="flex flex-row items-center rounded-[0.5rem] relative border">
							<KTabs.Trigger
								value="default"
								class="z-10 flex-1 py-2.5 text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-12 peer"
							>
								Default
							</KTabs.Trigger>
							<KTabs.Trigger
								value="cameraOnly"
								class="z-10 flex-1 py-2.5 text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-12 peer"
							>
								Camera Only
							</KTabs.Trigger>
							<KTabs.Trigger
								value="hideCamera"
								class="z-10 flex-1 py-2.5 text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-12 peer"
							>
								Hide Camera
							</KTabs.Trigger>
							<KTabs.Indicator class="absolute flex p-px inset-0 transition-transform peer-focus-visible:outline outline-2 outline-blue-9 outline-offset-2 rounded-[0.6rem] overflow-hidden">
								<div class="flex-1 bg-gray-3" />
							</KTabs.Indicator>
						</div>

						<div class="relative">
							<div
								class="absolute -top-3 w-px h-3 transition-all duration-200 bg-gray-3"
								style={{
									left:
										props.segment.mode === "cameraOnly"
											? "50%"
											: props.segment.mode === "hideCamera"
												? "83.33%"
												: "16.67%",
								}}
							/>
							<div
								class="absolute -top-1 w-2 h-2 rounded-full transition-all duration-200 -translate-x-1/2 bg-gray-3"
								style={{
									left:
										props.segment.mode === "cameraOnly"
											? "50%"
											: props.segment.mode === "hideCamera"
												? "83.33%"
												: "16.67%",
								}}
							/>
							<div class="p-2.5 rounded-md bg-gray-2 border border-gray-3">
								<div class="text-xs text-center text-gray-11">
									{props.segment.mode === "cameraOnly"
										? "Shows only the camera feed"
										: props.segment.mode === "hideCamera"
											? "Shows only the screen recording"
											: "Shows both screen and camera"}
								</div>
							</div>
						</div>
					</KTabs.List>
				</KTabs>
			</Field>
		</>
	);
}

function RgbInput(props: {
	value: [number, number, number];
	onChange: (value: [number, number, number]) => void;
}) {
	const [text, setText] = createWritableMemo(() => rgbToHex(props.value));
	let prevHex = rgbToHex(props.value);

	let colorInput!: HTMLInputElement;

	return (
		<div class="flex flex-row items-center gap-[0.75rem] relative">
			<button
				type="button"
				class="size-[2rem] rounded-[0.5rem]"
				style={{
					"background-color": rgbToHex(props.value),
				}}
				onClick={() => colorInput.click()}
			/>
			<input
				ref={colorInput}
				type="color"
				class="absolute left-0 bottom-0 w-[3rem] opacity-0"
				value={rgbToHex(props.value)}
				onChange={(e) => {
					const value = hexToRgb(e.target.value);
					if (!value) return;

					// RgbInput only handles RGB values, so extract RGB part if RGBA is returned
					const [r, g, b] = value;
					props.onChange([r, g, b]);
				}}
			/>
			<TextInput
				class="w-[4.60rem] p-[0.375rem] text-gray-12 text-[13px] border rounded-[0.5rem] bg-gray-1 outline-none focus:ring-1 transition-shadows duration-200 focus:ring-gray-500 focus:ring-offset-1 focus:ring-offset-gray-200"
				value={text()}
				onFocus={() => {
					prevHex = rgbToHex(props.value);
				}}
				onInput={(e) => {
					setText(e.currentTarget.value);

					const value = hexToRgb(e.target.value);
					if (!value) return;

					const [r, g, b] = value;
					props.onChange([r, g, b]);
				}}
				onBlur={(e) => {
					const value = hexToRgb(e.target.value);
					if (value) {
						const [r, g, b] = value;
						// RgbInput only handles RGB values, so extract RGB part if RGBA is returned
						props.onChange([r, g, b]);
					} else {
						setText(prevHex);
						const fallbackValue = hexToRgb(text());
						if (!fallbackValue) return;

						const [r, g, b] = fallbackValue;
						props.onChange([r, g, b]);
					}
				}}
			/>
		</div>
	);
}

function rgbToHex(rgb: [number, number, number]) {
	return `#${rgb
		.map((c) => c.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase()}`;
}

function hexToRgb(hex: string): [number, number, number, number] | null {
	// Support both 6-digit (RGB) and 8-digit (RGBA) hex colors
	const match = hex.match(
		/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})?$/i,
	);
	if (!match) return null;

	const [, r, g, b, a] = match;
	const rgb = [
		Number.parseInt(r, 16),
		Number.parseInt(g, 16),
		Number.parseInt(b, 16),
	] as const;

	// If alpha is provided, return RGBA tuple
	if (a) {
		return [...rgb, Number.parseInt(a, 16)];
	}

	return [...rgb, 255];
}

const CHECKERED_BUTTON_BACKGROUND = `url("data:image/svg+xml,%3Csvg width='16' height='16' xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='8' height='8' fill='%23a0a0a0'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%23a0a0a0'/%3E%3C/svg%3E")`;
