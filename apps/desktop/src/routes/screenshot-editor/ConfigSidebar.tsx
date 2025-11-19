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
import { createEventListenerMap } from "@solid-primitives/event-listener";
import { createWritableMemo } from "@solid-primitives/memo";
import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir, resolveResource } from "@tauri-apps/api/path";
import { BaseDirectory, writeFile } from "@tauri-apps/plugin-fs";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
	batch,
	createMemo,
	createResource,
	createSignal,
	For,
	onMount,
	Show,
	type ValidComponent,
} from "solid-js";
import { createStore } from "solid-js/store";
import { Dynamic } from "solid-js/web";
import toast from "solid-toast";
import colorBg from "~/assets/illustrations/color.webp";
import gradientBg from "~/assets/illustrations/gradient.webp";
import imageBg from "~/assets/illustrations/image.webp";
import transparentBg from "~/assets/illustrations/transparent.webp";
import { Toggle } from "~/components/Toggle";
import type { BackgroundSource } from "~/utils/tauri";
import IconCapBgBlur from "~icons/cap/bg-blur";
import IconCapChevronDown from "~icons/cap/chevron-down";
import IconCapCircleX from "~icons/cap/circle-x";
import IconCapCorners from "~icons/cap/corners";
import IconCapEnlarge from "~icons/cap/enlarge";
import IconCapImage from "~icons/cap/image";
import IconCapPadding from "~icons/cap/padding";
import IconCapSettings from "~icons/cap/settings";
import IconCapShadow from "~icons/cap/shadow";
import {
	DEFAULT_GRADIENT_FROM,
	DEFAULT_GRADIENT_TO,
	type RGBColor,
} from "../editor/projectConfig";
import { useScreenshotEditorContext } from "./context";
import ShadowSettings from "./ShadowSettings";
import { TextInput } from "./TextInput";
import {
	Field,
	MenuItem,
	MenuItemList,
	PopperContent,
	Slider,
	topSlideAnimateClasses,
} from "./ui";

// Constants
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

// Copied gradients
const BACKGROUND_GRADIENTS = [
	{ from: [15, 52, 67], to: [52, 232, 158] },
	{ from: [34, 193, 195], to: [253, 187, 45] },
	{ from: [29, 253, 251], to: [195, 29, 253] },
	{ from: [69, 104, 220], to: [176, 106, 179] },
	{ from: [106, 130, 251], to: [252, 92, 125] },
	{ from: [131, 58, 180], to: [253, 29, 29] },
	{ from: [249, 212, 35], to: [255, 78, 80] },
	{ from: [255, 94, 0], to: [255, 42, 104] },
	{ from: [255, 0, 150], to: [0, 204, 255] },
	{ from: [0, 242, 96], to: [5, 117, 230] },
	{ from: [238, 205, 163], to: [239, 98, 159] },
	{ from: [44, 62, 80], to: [52, 152, 219] },
	{ from: [168, 239, 255], to: [238, 205, 163] },
	{ from: [74, 0, 224], to: [143, 0, 255] },
	{ from: [252, 74, 26], to: [247, 183, 51] },
	{ from: [0, 255, 255], to: [255, 20, 147] },
	{ from: [255, 127, 0], to: [255, 255, 0] },
	{ from: [255, 0, 255], to: [0, 255, 0] },
] satisfies Array<{ from: RGBColor; to: RGBColor }>;

const WALLPAPER_NAMES = [
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
	"blue/1",
	"blue/2",
	"blue/3",
	"blue/4",
	"blue/5",
	"blue/6",
	"purple/1",
	"purple/2",
	"purple/3",
	"purple/4",
	"purple/5",
	"purple/6",
	"dark/1",
	"dark/2",
	"dark/3",
	"dark/4",
	"dark/5",
	"dark/6",
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

const BACKGROUND_THEMES = {
	macOS: "macOS",
	dark: "Dark",
	blue: "Blue",
	purple: "Purple",
	orange: "Orange",
};

export type CornerRoundingType = "rounded" | "squircle";
const CORNER_STYLE_OPTIONS = [
	{ name: "Squircle", value: "squircle" },
	{ name: "Rounded", value: "rounded" },
] satisfies Array<{ name: string; value: CornerRoundingType }>;

export function ConfigSidebar() {
	const [selectedTab, setSelectedTab] = createSignal("background");
	let scrollRef!: HTMLDivElement;

	return (
		<KTabs
			value={selectedTab()}
			onChange={setSelectedTab}
			class="flex flex-col min-h-0 shrink-0 flex-1 max-w-[26rem] overflow-hidden rounded-xl z-10 bg-gray-1 dark:bg-gray-2 border border-gray-3"
		>
			<KTabs.List class="flex overflow-hidden sticky top-0 z-[60] flex-row items-center h-16 text-lg border-b border-gray-3 shrink-0 bg-gray-1 dark:bg-gray-2">
				<For each={[{ id: "background", icon: IconCapImage }]}>
					{(item) => (
						<KTabs.Trigger
							value={item.id}
							class={cx(
								"flex relative z-10 flex-1 justify-center items-center px-4 py-2 transition-colors group disabled:opacity-50 focus:outline-none",
								"text-gray-11 ui-selected:text-gray-12",
							)}
						>
							<div
								class={cx(
									"flex justify-center relative border-transparent border z-10 items-center rounded-md size-9 transition will-change-transform",
									selectedTab() !== item.id &&
										"group-hover:border-gray-300 group-disabled:border-none",
								)}
							>
								<Dynamic component={item.icon} />
							</div>
						</KTabs.Trigger>
					)}
				</For>

				<KTabs.Indicator class="absolute top-0 left-0 w-full h-full transition-transform duration-200 ease-in-out pointer-events-none will-change-transform">
					<div class="absolute top-1/2 left-1/2 rounded-lg transform -translate-x-1/2 -translate-y-1/2 bg-gray-3 will-change-transform size-9" />
				</KTabs.Indicator>
			</KTabs.List>

			<div
				ref={scrollRef}
				class="custom-scroll overflow-x-hidden overflow-y-scroll text-[0.875rem] flex-1 min-h-0"
			>
				<BackgroundConfig scrollRef={scrollRef} />
			</div>
		</KTabs>
	);
}

function BackgroundConfig(props: { scrollRef: HTMLDivElement }) {
	const { project, setProject, projectHistory } = useScreenshotEditorContext();

	// Background tabs
	const [backgroundTab, setBackgroundTab] =
		createSignal<keyof typeof BACKGROUND_THEMES>("macOS");

	const [wallpapers] = createResource(async () => {
		// Only load visible wallpapers initially
		const visibleWallpaperPaths = WALLPAPER_NAMES.map(async (id) => {
			try {
				const path = await resolveResource(`assets/backgrounds/${id}.jpg`);
				return { id, path };
			} catch (err) {
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
			scroll: () => {
				const el = backgroundRef();
				if (el) {
					setScrollX(el.scrollLeft);
					const reachedEnd = el.scrollWidth - el.clientWidth - el.scrollLeft;
					setReachedEndOfScroll(reachedEnd === 0);
				}
			},
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
	const hapticsEnabled = ostype() === "macos";

	const setProjectSource = (source: any) => {
		setProject("background", "source", source);
	};

	// Debounced set project for history
	const debouncedSetProject = (wallpaperPath: string) => {
		const resumeHistory = projectHistory.pause();
		queueMicrotask(() => {
			batch(() => {
				setProject("background", "source", {
					type: "wallpaper",
					path: wallpaperPath,
				} as const);
				resumeHistory();
			});
		});
	};

	const ensurePaddingForBackground = () => {
		batch(() => {
			const isPaddingZero = project.background.padding === 0;
			const isRoundingZero = project.background.rounding === 0;

			if (isPaddingZero) {
				setProject("background", "padding", 10);
			}

			if (isPaddingZero && isRoundingZero) {
				setProject("background", "rounding", 8);
			}
		});
	};

	return (
		<KTabs.Content value="background" class="flex flex-col gap-6 p-4">
			<Field icon={<IconCapImage class="size-4" />} name="Background Image">
				<KTabs
					value={project.background.source.type}
					onChange={(v) => {
						const tab = v as BackgroundSource["type"];
						let newSource: any;
						switch (tab) {
							case "wallpaper":
								newSource = { type: "wallpaper", path: null };
								break;
							case "image":
								newSource = { type: "image", path: null };
								break;
							case "color":
								newSource = { type: "color", value: DEFAULT_GRADIENT_FROM };
								break;
							case "gradient":
								newSource = {
									type: "gradient",
									from: DEFAULT_GRADIENT_FROM,
									to: DEFAULT_GRADIENT_TO,
								};
								break;
						}

						// Try to preserve existing if type matches
						if (project.background.source.type === tab) {
							newSource = project.background.source;
						}

						setProjectSource(newSource);
						if (tab === "wallpaper" || tab === "image" || tab === "gradient") {
							ensurePaddingForBackground();
						}
					}}
				>
					<KTabs.List class="flex flex-row gap-2 items-center rounded-[0.5rem] relative">
						<For each={BACKGROUND_SOURCES_LIST}>
							{(item) => {
								return (
									<KTabs.Trigger
										class="z-10 flex-1 py-2.5 px-2 text-xs text-gray-11  ui-selected:border-gray-3 ui-selected:bg-gray-3 ui-not-selected:hover:border-gray-7 rounded-[10px] transition-colors duration-200 outline-none border ui-selected:text-gray-12 peer"
										value={item}
									>
										{BACKGROUND_SOURCES[item]}
									</KTabs.Trigger>
								);
							}}
						</For>
					</KTabs.List>

					<div class="my-5 w-full border-t border-dashed border-gray-5" />

					<KTabs.Content value="wallpaper">
						<KTabs class="overflow-hidden relative" value={backgroundTab()}>
							<KTabs.List
								ref={setBackgroundRef}
								class="flex overflow-x-auto overscroll-contain relative z-10 flex-row gap-2 items-center mb-3 text-xs hide-scroll"
							>
								<For each={Object.entries(BACKGROUND_THEMES)}>
									{([key, value]) => (
										<KTabs.Trigger
											onClick={() =>
												setBackgroundTab(key as keyof typeof BACKGROUND_THEMES)
											}
											value={key}
											class="flex relative z-10 flex-1 justify-center items-center px-4 py-2 bg-transparent rounded-lg border transition-colors duration-200 text-gray-11 ui-not-selected:hover:border-gray-7 ui-selected:bg-gray-3 ui-selected:border-gray-3 group ui-selected:text-gray-12 disabled:opacity-50 focus:outline-none"
										>
											{value}
										</KTabs.Trigger>
									)}
								</For>
							</KTabs.List>
						</KTabs>

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
								const wallpaper = wallpapers()?.find((w) => w.url === photoUrl);
								if (wallpaper) {
									debouncedSetProject(wallpaper.rawPath);
									ensurePaddingForBackground();
								}
							}}
							class="grid grid-cols-7 gap-2 h-auto"
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
												setProjectSource({
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
								const fileName = `bg-${Date.now()}-${file.name}`;
								const arrayBuffer = await file.arrayBuffer();
								const uint8Array = new Uint8Array(arrayBuffer);

								const fullPath = `${await appDataDir()}/${fileName}`;

								await writeFile(fileName, uint8Array, {
									baseDir: BaseDirectory.AppData,
								});

								setProjectSource({
									type: "image",
									path: fullPath,
								});
								ensurePaddingForBackground();
							}}
						/>
					</KTabs.Content>

					<KTabs.Content value="color">
						<div class="flex flex-col flex-wrap gap-3">
							<div class="flex flex-row items-center w-full h-10">
								<RgbInput
									value={
										project.background.source.type === "color"
											? project.background.source.value
											: [0, 0, 0]
									}
									onChange={(v) =>
										setProjectSource({ type: "color", value: v })
									}
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
													if (e.target.checked) {
														const rgb = hexToRgb(color);
														if (rgb)
															setProjectSource({
																type: "color",
																value: [rgb[0], rgb[1], rgb[2]],
																alpha: rgb[3],
															});
													}
												}}
											/>
											<div
												class="rounded-lg transition-all duration-200 cursor-pointer size-8 peer-checked:hover:opacity-100 peer-hover:opacity-70 peer-checked:ring-2 peer-checked:ring-gray-500 peer-checked:ring-offset-2 peer-checked:ring-offset-gray-200"
												style={{ background: color }}
											/>
										</label>
									)}
								</For>
							</div>
						</div>
					</KTabs.Content>

					<KTabs.Content value="gradient">
						<Show
							when={
								project.background.source.type === "gradient" &&
								project.background.source
							}
						>
							{(source) => {
								const angle = () => source().angle ?? 90;
								return (
									<div class="flex flex-col gap-3">
										<div class="flex gap-5 h-10">
											<RgbInput
												value={source().from}
												onChange={(from) =>
													setProjectSource({ ...source(), from })
												}
											/>
											<RgbInput
												value={source().to}
												onChange={(to) => setProjectSource({ ...source(), to })}
											/>
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
																	setProjectSource({
																		type: "gradient",
																		from: gradient.from,
																		to: gradient.to,
																	});
																	ensurePaddingForBackground();
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
						value={project.background.roundingType || "squircle"}
						onChange={(v) => setProject("background", "roundingType", v)}
					/>
				</div>
			</Field>

			<Field name="Shadow" icon={<IconCapShadow class="size-4" />}>
				<Slider
					value={[project.background.shadow!]}
					onChange={(v) => {
						batch(() => {
							setProject("background", "shadow", v[0]);
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
		</KTabs.Content>
	);
}

// Utils

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
	if (a) {
		return [...rgb, Number.parseInt(a, 16)];
	}
	return [...rgb, 255];
}
