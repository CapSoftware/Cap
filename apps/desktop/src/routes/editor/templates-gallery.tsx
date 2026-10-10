import { DropdownMenu as KDropdownMenu } from "@kobalte/core/dropdown-menu";
import { Popover as KPopover } from "@kobalte/core/popover";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { resolveResource } from "@tauri-apps/api/path";
import { cx } from "cva";
import {
	createMemo,
	createResource,
	createSignal,
	For,
	type JSX,
	Show,
} from "solid-js";
import { produce, reconcile } from "solid-js/store";
import toast from "solid-toast";
import type {
	AspectRatio,
	BackgroundSource,
	Camera,
	ProjectConfiguration,
	SceneMode,
} from "~/utils/tauri";
import { commands } from "~/utils/tauri";
import IconLucideCheck from "~icons/lucide/check";
import IconLucideMoreHorizontal from "~icons/lucide/more-horizontal";
import IconLucidePlus from "~icons/lucide/plus";
import IconLucideSwatchBook from "~icons/lucide/swatch-book";
import { clipDuration } from "./clip-transitions";
import { normalizeProject, useEditorContext } from "./context";
import {
	applyTemplate,
	type DefaultLook,
	defaultLookKey,
	EDITOR_TEMPLATES,
	type EditorTemplate,
	fullSpanScene,
	lookKey,
	templateBackgroundSource,
	templateDefaultConfig,
	templateDefaultKey,
	templateLookKey,
	withoutTemplateScene,
} from "./templates";
import {
	DropdownItem,
	EditorButton,
	PopperContent,
	topCenterAnimateClasses,
} from "./ui";

const isWebEditor = import.meta.env.VITE_CAP_WEB_EDITOR === "true";

const CAP_DEFAULT_KEY = "cap-default";

const GROUPS: Array<{ id: EditorTemplate["group"]; title: string }> = [
	{ id: "layout", title: "Layouts" },
	{ id: "look", title: "Looks" },
	{ id: "social", title: "Social" },
];

type Filter = "all" | EditorTemplate["group"] | "presets";

const FILTERS: Array<{ id: Filter; title: string }> = [
	{ id: "all", title: "All" },
	...GROUPS,
	{ id: "presets", title: "Your presets" },
];

type PreviewLook = {
	aspectRatio: AspectRatio | null;
	background: string;
	padding: number;
	rounding: number;
	shadow: number;
	camera: Pick<Camera, "hide" | "position" | "size" | "rounding">;
	scene?: SceneMode;
};

const wallpaperPath = (id: string) =>
	resolveResource(`assets/backgrounds/${id}.jpg`);

const rgb = (value: [number, number, number]) =>
	`rgb(${value[0]} ${value[1]} ${value[2]})`;

function backgroundCss(source: BackgroundSource) {
	switch (source.type) {
		case "color":
			return rgb(source.value);
		case "gradient":
			return `linear-gradient(${source.angle ?? 90}deg, ${rgb(source.from)}, ${rgb(source.to)})`;
		case "wallpaper":
		case "image":
			return source.path
				? `center / cover url("${convertFileSrc(
						source.type === "wallpaper"
							? source.path.replace(/\.jpg$/, "-thumbnail.jpg")
							: source.path,
					)}")`
				: "#1c1c1f";
		default:
			return "linear-gradient(135deg, #3b2f6b, #1d4f91)";
	}
}

/**
 * Ready-made looks and layouts, previewed with the person's own recording,
 * next to the presets they've saved. Any of them can become the look new
 * recordings start with.
 */
export function TemplatesGallery() {
	const { project, setProject, presets, setDialog, totalDuration } =
		useEditorContext();
	const [open, setOpen] = createSignal(false);
	const [filter, setFilter] = createSignal<Filter>("all");
	const [defaultConfig] = createResource(open, () =>
		commands.getDefaultProjectConfig().catch(() => null),
	);
	// null is Cap's own look; undefined is not known yet.
	const [savedStyle, { mutate: setSavedStyle }] = createResource(open, () =>
		invoke<DefaultLook | null>("webEditorDefaultStyle").catch(() => undefined),
	);
	const [pendingDefault, setPendingDefault] = createSignal<string | null>(null);

	const [frames] = createResource(open, async () => {
		const first = project.timeline?.segments[0];
		const middle = first ? first.start + clipDuration(first) / 2 : 1;
		const [screen, camera] = await Promise.all([
			commands
				.getClipThumbnail(first?.recordingSegment ?? 0, middle)
				.catch(() => null),
			isWebEditor
				? invoke<string>("webEditorCameraThumbnail").catch(() => null)
				: null,
		]);
		return { screen: screen ? convertFileSrc(screen) : null, camera };
	});

	const [wallpapers] = createResource(open, async () => {
		const ids = EDITOR_TEMPLATES.flatMap((template) =>
			template.background.type === "wallpaper" ? [template.background.id] : [],
		);
		const entries = await Promise.all(
			ids.map(async (id) => [id, await wallpaperPath(id)] as const),
		);
		return new Map(entries);
	});

	const templateLook = (template: EditorTemplate): PreviewLook => {
		const background = template.background;
		const path =
			background.type === "wallpaper"
				? (wallpapers()?.get(background.id) ?? null)
				: null;
		return {
			...template,
			background:
				background.type === "wallpaper"
					? backgroundCss({ type: "wallpaper", path })
					: backgroundCss(background),
		};
	};

	let templateScene: SceneMode | null = null;

	const apply = async (template: EditorTemplate) => {
		try {
			const source = await templateBackgroundSource(
				template.background,
				wallpaperPath,
			);
			setProject(
				produce((draft) =>
					applyTemplate(draft, template, source, totalDuration()),
				),
			);
			templateScene = template.scene ?? null;
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Template could not be applied",
			);
		}
	};

	const applyConfig = async (config: ProjectConfiguration) => {
		if (isWebEditor) {
			const prepare = (
				window as Window & {
					capWebEditorPreparePresetBackground?: (
						config: unknown,
					) => Promise<void>;
				}
			).capWebEditorPreparePresetBackground;
			try {
				await prepare?.(config);
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: "Preset background could not be loaded",
				);
				return;
			}
		}
		const timeline = project.timeline;
		const scene = templateScene;
		templateScene = null;
		setProject(
			reconcile(
				normalizeProject({
					...config,
					timeline:
						timeline && scene
							? {
									...timeline,
									sceneSegments: withoutTemplateScene(
										timeline.sceneSegments,
										scene,
										totalDuration(),
									),
								}
							: (timeline ?? null),
					overlayOrder: project.overlayOrder ?? [],
					clips: project.clips,
				}),
			),
		);
	};

	const applyPreset = (index: number) => {
		const preset = presets.query.data?.presets[index];
		if (preset) return applyConfig(preset.config);
	};

	// A card shows as chosen while the project still looks the way it made it.
	const currentLook = createMemo(() =>
		lookKey(
			project,
			fullSpanScene(project.timeline?.sceneSegments, totalDuration()),
		),
	);
	const showsConfig = (config: ProjectConfiguration) =>
		currentLook() === lookKey(config, null);
	const showsTemplate = (template: EditorTemplate) =>
		currentLook() === templateLookKey(template, wallpaperFor(template));

	const savedPresets = () => presets.query.data?.presets ?? [];

	const defaultKey = () => {
		const pending = pendingDefault();
		if (pending) return pending;
		const style = savedStyle();
		if (style === undefined) return undefined;
		return style === null ? CAP_DEFAULT_KEY : defaultLookKey(style);
	};

	const wallpaperFor = (template: EditorTemplate) =>
		template.background.type === "wallpaper"
			? (wallpapers()?.get(template.background.id) ?? null)
			: null;

	const defaultName = createMemo(() => {
		const key = defaultKey();
		if (key === undefined) return undefined;
		if (key === CAP_DEFAULT_KEY) return "Cap default";
		const preset = savedPresets().find(
			(preset) => defaultLookKey(preset.config) === key,
		);
		if (preset) return preset.name;
		const template = EDITOR_TEMPLATES.find(
			(template) =>
				!template.scene &&
				templateDefaultKey(template, wallpaperFor(template)) === key,
		);
		return template?.name ?? null;
	});

	const makeDefault = async (
		key: string,
		name: string,
		config: ProjectConfiguration | null,
	) => {
		setPendingDefault(key);
		try {
			setSavedStyle(
				await invoke<DefaultLook | null>("webEditorSaveDefaultStyle", {
					config: config && JSON.parse(JSON.stringify(config)),
				}),
			);
			toast.success(`New recordings will start with ${name}`);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Default was not saved",
			);
		} finally {
			setPendingDefault(null);
		}
	};

	const makeTemplateDefault = (template: EditorTemplate) => {
		const base = defaultConfig();
		const config =
			base && templateDefaultConfig(base, template, wallpaperFor(template));
		if (!config) return undefined;
		return () =>
			void makeDefault(
				templateDefaultKey(template, wallpaperFor(template)),
				template.name,
				config,
			);
	};

	const presetLook = (config: ProjectConfiguration): PreviewLook => ({
		aspectRatio: config.aspectRatio,
		background: backgroundCss(config.background.source),
		padding: config.background.padding,
		rounding: config.background.rounding,
		shadow: config.background.shadow,
		camera: config.camera,
	});

	const savePreset = () => {
		setOpen(false);
		setDialog({ type: "createPreset", open: true });
	};

	const visibleGroups = () =>
		filter() === "all"
			? GROUPS
			: GROUPS.filter((group) => group.id === filter());
	const showPresets = () => filter() === "all" || filter() === "presets";

	return (
		<KPopover
			open={open()}
			onOpenChange={setOpen}
			placement="bottom"
			gutter={8}
			flip
			fitViewport
		>
			<EditorButton<typeof KPopover.Trigger>
				as={KPopover.Trigger}
				leftIcon={<IconLucideSwatchBook class="size-4" />}
				tooltipText="Presets"
			>
				<span class="max-[1200px]:hidden">Presets</span>
			</EditorButton>
			<KPopover.Portal>
				<KPopover.Content
					class={cx(
						"z-60 flex h-[min(38rem,calc(100vh-7rem))] w-[min(50rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl bg-ed-card shadow-ed-pop outline-hidden",
						"origin-[var(--kb-popover-content-transform-origin)] data-expanded:animate-in data-expanded:fade-in data-expanded:zoom-in-95 data-closed:animate-out data-closed:fade-out data-closed:zoom-out-95",
					)}
				>
					<div class="flex items-start justify-between gap-4 px-5 pb-3 pt-4">
						<div class="flex flex-col gap-0.5">
							<KPopover.Title class="text-[15px] font-medium tracking-[-0.01em] text-ed-text-1">
								Presets
							</KPopover.Title>
							<KPopover.Description class="text-[12px] text-ed-text-2">
								Start from a look, or make one the default for new recordings.
								Everything stays editable.
							</KPopover.Description>
						</div>
						<button
							type="button"
							onClick={savePreset}
							class="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-ed-accent px-3 text-[12px] font-medium text-white outline-hidden transition-[filter] hover:brightness-[1.06]"
						>
							<IconLucidePlus class="size-3.5" />
							Save current style
						</button>
					</div>
					<div class="flex gap-1 border-b border-ed-line px-5 pb-3">
						<For each={FILTERS}>
							{(item) => (
								<button
									type="button"
									onClick={() => setFilter(item.id)}
									class={cx(
										"h-7 rounded-full px-3 text-[12px] font-medium outline-hidden transition-colors",
										filter() === item.id
											? "bg-ed-text-1 text-ed-card"
											: "text-ed-text-2 hover:bg-ed-ctl-hover hover:text-ed-text-1",
									)}
								>
									{item.title}
									<Show when={item.id === "presets" && savedPresets().length}>
										{(count) => (
											<span class="ml-1 tabular-nums opacity-60">
												{count()}
											</span>
										)}
									</Show>
								</button>
							)}
						</For>
					</div>
					<div class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
						<Show when={showPresets()}>
							<section class="flex flex-col gap-3">
								<h3 class="text-[12px] font-medium text-ed-text-2">
									Your presets
								</h3>
								<div class="grid grid-cols-3 gap-x-3 gap-y-4 max-[640px]:grid-cols-2">
									<Show when={defaultConfig()}>
										{(config) => (
											<TemplateCard
												name="Cap default"
												description="Edge to edge, camera as recorded"
												active={showsConfig(config())}
												isDefault={defaultKey() === CAP_DEFAULT_KEY}
												onSelect={() => void applyConfig(config())}
												onMakeDefault={() =>
													void makeDefault(CAP_DEFAULT_KEY, "Cap default", null)
												}
												preview={
													<TemplatePreview
														look={presetLook(config())}
														screen={frames()?.screen ?? null}
														camera={frames()?.camera ?? null}
													/>
												}
											/>
										)}
									</Show>
									<For each={savedPresets()}>
										{(preset, index) => (
											<TemplateCard
												name={preset.name}
												description="Saved preset"
												active={showsConfig(preset.config)}
												isDefault={
													defaultKey() === defaultLookKey(preset.config)
												}
												onSelect={() => void applyPreset(index())}
												onMakeDefault={
													// Backgrounds from this browser's uploads stay with
													// the project, so they can't start other recordings.
													preset.config.background.source.type === "image"
														? undefined
														: () =>
																void makeDefault(
																	defaultLookKey(preset.config),
																	preset.name,
																	preset.config,
																)
												}
												menu={
													<PresetMenu
														onSaveHere={async () => {
															await presets.saveToPreset(index(), project);
															toast.success(`Saved to "${preset.name}"`);
														}}
														onRename={() => {
															setOpen(false);
															setDialog({
																type: "renamePreset",
																presetIndex: index(),
																open: true,
															});
														}}
														onDelete={() => {
															setOpen(false);
															setDialog({
																type: "deletePreset",
																presetIndex: index(),
																open: true,
															});
														}}
													/>
												}
												preview={
													<TemplatePreview
														look={presetLook(preset.config)}
														screen={frames()?.screen ?? null}
														camera={frames()?.camera ?? null}
													/>
												}
											/>
										)}
									</For>
									<button
										type="button"
										onClick={savePreset}
										class="flex aspect-video flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-ed-line-strong text-[12px] font-medium text-ed-text-2 outline-hidden transition-colors hover:border-ed-accent hover:bg-ed-accent/5 hover:text-ed-accent"
									>
										<IconLucidePlus class="size-4" />
										Save current style
									</button>
								</div>
							</section>
						</Show>
						<For each={visibleGroups()}>
							{(group) => (
								<section class="flex flex-col gap-3">
									<h3 class="text-[12px] font-medium text-ed-text-2">
										{group.title}
									</h3>
									<div class="grid grid-cols-3 gap-x-3 gap-y-4 max-[640px]:grid-cols-2">
										<For
											each={EDITOR_TEMPLATES.filter(
												(template) => template.group === group.id,
											)}
										>
											{(template) => (
												<TemplateCard
													name={template.name}
													description={template.description}
													active={showsTemplate(template)}
													isDefault={
														!template.scene &&
														defaultKey() ===
															templateDefaultKey(
																template,
																wallpaperFor(template),
															)
													}
													onSelect={() => void apply(template)}
													onMakeDefault={makeTemplateDefault(template)}
													preview={
														<TemplatePreview
															look={templateLook(template)}
															screen={frames()?.screen ?? null}
															camera={frames()?.camera ?? null}
														/>
													}
												/>
											)}
										</For>
									</div>
								</section>
							)}
						</For>
					</div>
					<Show when={defaultName() !== undefined}>
						<div class="border-t border-ed-line px-5 py-2.5 text-[12px] text-ed-text-2">
							New recordings start with{" "}
							<Show when={defaultName()} fallback="a style you saved earlier">
								{(name) => (
									<span class="font-medium text-ed-text-1">{name()}</span>
								)}
							</Show>
						</div>
					</Show>
				</KPopover.Content>
			</KPopover.Portal>
		</KPopover>
	);
}

function TemplateCard(props: {
	name: string;
	description: string;
	active: boolean;
	isDefault: boolean;
	preview: JSX.Element;
	menu?: JSX.Element;
	onSelect: () => void;
	onMakeDefault?: () => void;
}) {
	return (
		<div class="group relative flex flex-col gap-1.5">
			<button
				type="button"
				onClick={props.onSelect}
				class="flex flex-col gap-1.5 rounded-xl text-left outline-hidden"
			>
				<div
					class={cx(
						"relative w-full overflow-hidden rounded-xl transition-[box-shadow,transform] duration-200 group-hover:-translate-y-0.5",
						props.active
							? "shadow-[0_0_0_2px_var(--ed-accent)]"
							: "shadow-[0_0_0_1px_var(--ed-line)] group-hover:shadow-[0_0_0_1px_var(--ed-line-strong),0_8px_20px_-12px_rgba(0,0,0,0.35)]",
					)}
				>
					{props.preview}
					<Show when={props.active}>
						<span class="absolute left-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-ed-accent text-white">
							<IconLucideCheck class="size-3" />
						</span>
					</Show>
				</div>
				<span class="flex flex-col px-0.5">
					<span class="text-[13px] font-medium text-ed-text-1">
						{props.name}
					</span>
					<span class="truncate text-[12px] text-ed-text-3">
						{props.description}
					</span>
				</span>
			</button>
			<div class="pointer-events-none absolute inset-x-0 top-0 aspect-video transition-transform duration-200 group-hover:-translate-y-0.5">
				<Show
					when={props.isDefault}
					fallback={
						<Show when={props.onMakeDefault}>
							{(makeDefault) => (
								<button
									type="button"
									onClick={() => makeDefault()()}
									class="pointer-events-auto absolute bottom-1.5 right-1.5 flex h-6 items-center rounded-full bg-black/60 px-2.5 text-[11px] font-medium text-white opacity-0 outline-hidden backdrop-blur-sm transition-[opacity,background-color] duration-150 hover:bg-black/80 focus-visible:opacity-100 group-hover:opacity-100"
								>
									Make default
								</button>
							)}
						</Show>
					}
				>
					<span class="absolute bottom-1.5 right-1.5 flex h-6 items-center gap-1 rounded-full bg-white pl-1.5 pr-2.5 text-[11px] font-medium text-[#141416] shadow-[0_1px_4px_rgba(0,0,0,0.25)]">
						<IconLucideCheck class="size-3 text-ed-accent" />
						Default
					</span>
				</Show>
			</div>
			{props.menu}
		</div>
	);
}

function PresetMenu(props: {
	onSaveHere: () => void;
	onRename: () => void;
	onDelete: () => void;
}) {
	return (
		<KDropdownMenu gutter={6} placement="bottom-end">
			<KDropdownMenu.Trigger
				aria-label="Preset options"
				class="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-md bg-black/55 text-white opacity-0 outline-hidden transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-expanded:opacity-100"
			>
				<IconLucideMoreHorizontal class="size-3.5" />
			</KDropdownMenu.Trigger>
			<KDropdownMenu.Portal>
				<PopperContent<typeof KDropdownMenu.Content>
					as={KDropdownMenu.Content}
					class={cx("z-70 w-48 p-1", topCenterAnimateClasses)}
				>
					<DropdownItem onSelect={props.onSaveHere}>
						Save current style here
					</DropdownItem>
					<DropdownItem onSelect={props.onRename}>Rename</DropdownItem>
					<DropdownItem onSelect={props.onDelete}>Delete</DropdownItem>
				</PopperContent>
			</KDropdownMenu.Portal>
		</KDropdownMenu>
	);
}

function TemplatePreview(props: {
	look: PreviewLook;
	screen: string | null;
	camera: string | null;
}) {
	const frameAspect = createMemo(() =>
		props.look.aspectRatio === "vertical"
			? 9 / 16
			: props.look.aspectRatio === "square"
				? 1
				: props.look.aspectRatio === "classic"
					? 4 / 3
					: 16 / 9,
	);
	const inset = () => `${props.look.padding * 0.9}%`;
	const radius = () => `${Math.min(props.look.rounding, 40) * 0.18}%`;
	const shadow = () =>
		props.look.shadow > 0
			? `0 ${props.look.shadow / 20}px ${props.look.shadow / 6}px rgba(0,0,0,${Math.min(0.5, props.look.shadow / 150)})`
			: "none";
	const screen = (style: JSX.CSSProperties) => (
		<div
			class="absolute overflow-hidden bg-[#1f1f23]"
			style={{ "box-shadow": shadow(), ...style }}
		>
			<Show when={props.screen}>
				{(src) => (
					<img
						src={src()}
						alt=""
						class="size-full object-cover"
						draggable={false}
					/>
				)}
			</Show>
		</div>
	);
	const camera = (style: JSX.CSSProperties) => (
		<div
			class="absolute overflow-hidden bg-linear-to-br from-[#8e8e99] to-[#4a4a55]"
			style={{ "box-shadow": "0 2px 8px rgba(0,0,0,0.35)", ...style }}
		>
			<Show when={props.camera}>
				{(src) => (
					<img
						src={src()}
						alt=""
						class="size-full -scale-x-100 object-cover"
						draggable={false}
					/>
				)}
			</Show>
		</div>
	);
	const cameraSide = () => `${props.look.camera.size * 0.62}%`;
	const cameraPlacement = (): JSX.CSSProperties => {
		const { x, y } = props.look.camera.position;
		return {
			width: cameraSide(),
			"aspect-ratio": "1",
			"border-radius": `${props.look.camera.rounding * 0.3}%`,
			...(x === "left"
				? { left: "5%" }
				: x === "center"
					? { left: "50%", transform: "translateX(-50%)" }
					: { right: "5%" }),
			...(y === "top" ? { top: "7%" } : { bottom: "7%" }),
		};
	};

	return (
		<div
			class="relative flex aspect-video w-full items-center justify-center bg-ed-ctl"
			aria-hidden="true"
		>
			<div
				class="relative h-full overflow-hidden"
				style={{
					"aspect-ratio": `${frameAspect()}`,
					background: props.look.background,
				}}
			>
				<Show
					when={props.look.scene === "cameraOnly"}
					fallback={
						<Show
							when={
								props.look.scene === "floating" ||
								props.look.scene === "splitScreen"
							}
							fallback={
								<>
									{screen({
										inset: inset(),
										"border-radius": radius(),
									})}
									<Show when={!props.look.camera.hide}>
										{camera(cameraPlacement())}
									</Show>
								</>
							}
						>
							{props.look.scene === "splitScreen"
								? [
										screen(
											frameAspect() < 1
												? { inset: "0 0 50% 0" }
												: { inset: "0 50% 0 0" },
										),
										camera(
											frameAspect() < 1
												? { inset: "50% 0 0 0" }
												: { inset: "0 0 0 50%" },
										),
									]
								: [
										screen(
											frameAspect() < 1
												? { inset: "6% 6% 52% 6%", "border-radius": radius() }
												: {
														inset: "12% 51% 12% 4%",
														"border-radius": radius(),
													},
										),
										camera(
											frameAspect() < 1
												? { inset: "52% 6% 6% 6%", "border-radius": radius() }
												: {
														inset: "12% 4% 12% 51%",
														"border-radius": radius(),
													},
										),
									]}
						</Show>
					}
				>
					{camera({ inset: "0" })}
				</Show>
			</div>
		</div>
	);
}
