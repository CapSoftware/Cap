import { Popover } from "@kobalte/core/popover";
import { RadioGroup as KRadioGroup } from "@kobalte/core/radio-group";
import { Tabs as KTabs } from "@kobalte/core/tabs";
import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir, resolveResource } from "@tauri-apps/api/path";
import { BaseDirectory, writeFile } from "@tauri-apps/plugin-fs";
import {
	batch,
	createMemo,
	createResource,
	createSignal,
	For,
	Show,
} from "solid-js";
import type { BackgroundSource } from "~/utils/tauri";
import IconCapBgBlur from "~icons/cap/bg-blur";
import IconCapCircleX from "~icons/cap/circle-x";
import IconCapImage from "~icons/cap/image";
import {
	DEFAULT_GRADIENT_FROM,
	DEFAULT_GRADIENT_TO,
	type RGBColor,
} from "../../editor/projectConfig";
import { BACKGROUND_COLORS, hexToRgb, RgbInput } from "../ColorPicker";
import { useScreenshotEditorContext } from "../context";
import { EditorButton, Field, Slider } from "../ui";

// Constants
const BACKGROUND_SOURCES = {
	wallpaper: "Wallpaper",
	image: "Image",
	color: "Color",
	gradient: "Gradient",
} satisfies Record<BackgroundSource["type"], string>;

const BACKGROUND_SOURCES_LIST = [
	"wallpaper",
	"image",
	"color",
	"gradient",
] satisfies Array<BackgroundSource["type"]>;

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
	"orange/10",
] as const;

type WallpaperName = (typeof WALLPAPER_NAMES)[number];

const BACKGROUND_THEMES = {
	macOS: "macOS",
	dark: "Dark",
	blue: "Blue",
	purple: "Purple",
	orange: "Orange",
};

export function BackgroundSettingsPopover() {
	const { project, setProject, projectHistory } = useScreenshotEditorContext();

	let scrollRef!: HTMLDivElement;

	// Background tabs
	const [backgroundTab, setBackgroundTab] =
		createSignal<keyof typeof BACKGROUND_THEMES>("macOS");

	const [wallpapers] = createResource(async () => {
		// Only load visible wallpapers initially
		const visibleWallpaperPaths = WALLPAPER_NAMES.map(async (id) => {
			try {
				const path = await resolveResource(`assets/backgrounds/${id}.jpg`);
				return { id, path };
			} catch {
				return { id, path: null };
			}
		});

		// Load initial batch
		const initialPaths = await Promise.all(visibleWallpaperPaths);

		return initialPaths
			.filter((p): p is { id: WallpaperName; path: string } => p.path !== null)
			.map(({ id, path }) => ({
				id,
				url: convertFileSrc(path),
				rawPath: path,
			}));
	});

	const filteredWallpapers = createMemo(() => {
		const currentTab = backgroundTab();
		return wallpapers()?.filter((wp) => wp.id.startsWith(currentTab)) || [];
	});

	let fileInput!: HTMLInputElement;

	const setProjectSource = (source: BackgroundSource) => {
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
		<Popover placement="bottom-start">
			<Popover.Trigger
				as={EditorButton}
				leftIcon={<IconCapImage class="size-4" />}
				tooltipText="Background"
			/>
			<Popover.Portal>
				<Popover.Content class="z-50 w-[400px] overflow-hidden rounded-xl border border-gray-3 bg-gray-1 shadow-xl animate-in fade-in zoom-in-95">
					<div
						ref={scrollRef}
						class="max-h-[600px] overflow-y-auto p-4 flex flex-col gap-6"
					>
						<Field
							icon={<IconCapImage class="size-4" />}
							name="Background Image"
						>
							<KTabs
								value={project.background.source.type}
								onChange={(v) => {
									const tab = v as BackgroundSource["type"];
									let newSource: BackgroundSource;
									switch (tab) {
										case "wallpaper":
											newSource = { type: "wallpaper", path: null };
											break;
										case "image":
											newSource = { type: "image", path: null };
											break;
										case "color":
											newSource = {
												type: "color",
												value: DEFAULT_GRADIENT_FROM,
											};
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
									if (
										tab === "wallpaper" ||
										tab === "image" ||
										tab === "gradient"
									) {
										ensurePaddingForBackground();
									}
								}}
							>
								<KTabs.List class="flex flex-row gap-2 items-center rounded-lg relative">
									<For each={BACKGROUND_SOURCES_LIST}>
										{(item) => {
											return (
												<KTabs.Trigger
													class="z-10 flex-1 py-2.5 px-2 text-xs text-gray-11  data-selected:border-gray-3 data-selected:bg-gray-3 ui-not-selected:hover:border-gray-7 rounded-[10px] transition-colors duration-200 outline-none border data-selected:text-gray-12 peer"
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
									<KTabs
										class="overflow-hidden relative"
										value={backgroundTab()}
									>
										<KTabs.List class="flex overflow-x-auto overscroll-contain relative z-10 flex-row gap-2 items-center mb-3 text-xs hide-scroll">
											<For each={Object.entries(BACKGROUND_THEMES)}>
												{([key, value]) => (
													<KTabs.Trigger
														onClick={() =>
															setBackgroundTab(
																key as keyof typeof BACKGROUND_THEMES,
															)
														}
														value={key}
														class="flex relative z-10 flex-1 justify-center items-center px-4 py-2 bg-transparent rounded-lg border transition-colors duration-200 text-gray-11 ui-not-selected:hover:border-gray-7 data-selected:bg-gray-3 data-selected:border-gray-3 group data-selected:text-gray-12 disabled:opacity-50 focus:outline-none"
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
											const wallpaper = wallpapers()?.find(
												(w) => w.url === photoUrl,
											);
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
													value={photo.url}
													class="relative aspect-square group"
												>
													<KRadioGroup.ItemInput class="peer" />
													<KRadioGroup.ItemControl class="overflow-hidden w-full h-full rounded-lg transition cursor-pointer ui-not-checked:ring-offset-1 ui-not-checked:ring-offset-gray-200 ui-not-checked:hover:ring-1 ui-not-checked:hover:ring-gray-400 data-checked:ring-2 data-checked:ring-gray-500 data-checked:ring-offset-2 data-checked:ring-offset-gray-200">
														<img
															src={photo.url}
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
												class="p-6 bg-gray-2 text-[13px] w-full rounded-lg border border-gray-5 border-dashed flex flex-col items-center justify-center gap-2 hover:bg-gray-3 transition-colors duration-100"
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
															onChange={(to) =>
																setProjectSource({ ...source(), to })
															}
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
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
}
