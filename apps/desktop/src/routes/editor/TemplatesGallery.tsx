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
	SceneMode,
} from "~/utils/tauri";
import { commands } from "~/utils/tauri";
import IconLucideCheck from "~icons/lucide/check";
import IconLucideLayoutTemplate from "~icons/lucide/layout-template";
import IconLucideMoreHorizontal from "~icons/lucide/more-horizontal";
import IconLucidePlus from "~icons/lucide/plus";
import { clipDuration } from "./clip-transitions";
import {
	normalizeProject,
	serializeProjectConfiguration,
	useEditorContext,
} from "./context";
import {
	applyTemplate,
	EDITOR_TEMPLATES,
	type EditorTemplate,
	templateBackgroundSource,
} from "./templates";
import {
	DropdownItem,
	EditorButton,
	PopperContent,
	topCenterAnimateClasses,
} from "./ui";

const isWebEditor = import.meta.env.VITE_CAP_WEB_EDITOR === "true";

const GROUPS: Array<{ id: EditorTemplate["group"]; title: string }> = [
	{ id: "layout", title: "Layouts" },
	{ id: "look", title: "Looks" },
	{ id: "social", title: "Social" },
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
 * next to the presets they've saved.
 */
export function TemplatesGallery() {
	const { project, setProject, presets, setDialog, totalDuration } =
		useEditorContext();
	const [open, setOpen] = createSignal(false);
	const [applied, setApplied] = createSignal<string | null>(null);

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
			setApplied(template.id);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Template could not be applied",
			);
		}
	};

	const applyPreset = async (index: number) => {
		const preset = presets.query.data?.presets[index];
		if (!preset) return;
		if (isWebEditor) {
			const prepare = (
				window as Window & {
					capWebEditorPreparePresetBackground?: (
						config: unknown,
					) => Promise<void>;
				}
			).capWebEditorPreparePresetBackground;
			try {
				await prepare?.(preset.config);
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: "Preset background could not be loaded",
				);
				return;
			}
		}
		setProject(
			reconcile(
				normalizeProject({
					...preset.config,
					timeline: project.timeline ?? null,
					overlayOrder: project.overlayOrder ?? [],
					clips: project.clips,
				}),
			),
		);
		setApplied(`preset-${index}`);
	};

	const saveDefaultStyle = async () => {
		try {
			await invoke("webEditorSaveDefaultStyle", {
				config: JSON.parse(
					JSON.stringify(serializeProjectConfiguration(project)),
				),
			});
			toast.success("New recordings will use this style");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Default style was not saved",
			);
		}
	};

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
				leftIcon={<IconLucideLayoutTemplate class="size-4" />}
				tooltipText="Templates and presets"
			>
				<span class="max-[1200px]:hidden">Templates</span>
			</EditorButton>
			<KPopover.Portal>
				<KPopover.Content
					class={cx(
						"z-60 flex max-h-[min(40rem,calc(100vh-7rem))] w-[min(46rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl bg-ed-card shadow-ed-pop outline-hidden",
						"origin-[var(--kb-popover-content-transform-origin)] data-expanded:animate-in data-expanded:fade-in data-expanded:zoom-in-95 data-closed:animate-out data-closed:fade-out data-closed:zoom-out-95",
					)}
				>
					<div class="flex items-center justify-between gap-3 border-b border-ed-line px-4 py-3">
						<div class="flex flex-col">
							<KPopover.Title class="text-[14px] font-medium text-ed-text-1">
								Templates
							</KPopover.Title>
							<KPopover.Description class="text-[12px] text-ed-text-2">
								Pick a starting look. Everything stays editable, and Undo brings
								back what you had.
							</KPopover.Description>
						</div>
						<Show when={isWebEditor}>
							<button
								type="button"
								onClick={() => void saveDefaultStyle()}
								class="shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-ed-text-2 outline-hidden transition-colors hover:bg-ed-ctl-hover hover:text-ed-text-1"
							>
								Use current style for new recordings
							</button>
						</Show>
					</div>
					<div class="flex flex-col gap-5 overflow-y-auto p-4">
						<For each={GROUPS}>
							{(group) => (
								<section class="flex flex-col gap-2.5">
									<h3 class="text-[12px] font-medium text-ed-text-2">
										{group.title}
									</h3>
									<div class="grid grid-cols-3 gap-3 max-[640px]:grid-cols-2">
										<For
											each={EDITOR_TEMPLATES.filter(
												(template) => template.group === group.id,
											)}
										>
											{(template) => (
												<TemplateCard
													name={template.name}
													description={template.description}
													active={applied() === template.id}
													onSelect={() => void apply(template)}
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
						<section class="flex flex-col gap-2.5">
							<h3 class="text-[12px] font-medium text-ed-text-2">
								Your presets
							</h3>
							<div class="grid grid-cols-3 gap-3 max-[640px]:grid-cols-2">
								<For each={presets.query.data?.presets ?? []}>
									{(preset, index) => (
										<TemplateCard
											name={preset.name}
											description={
												presets.query.data?.default === index()
													? "Your default"
													: "Saved preset"
											}
											active={applied() === `preset-${index()}`}
											onSelect={() => void applyPreset(index())}
											menu={
												<PresetMenu
													isDefault={presets.query.data?.default === index()}
													onSaveHere={async () => {
														await presets.saveToPreset(index(), project);
														toast.success(`Saved to "${preset.name}"`);
													}}
													onSetDefault={() => presets.setDefault(index())}
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
													look={{
														aspectRatio: preset.config.aspectRatio,
														background: backgroundCss(
															preset.config.background.source,
														),
														padding: preset.config.background.padding,
														rounding: preset.config.background.rounding,
														shadow: preset.config.background.shadow,
														camera: preset.config.camera,
													}}
													screen={frames()?.screen ?? null}
													camera={frames()?.camera ?? null}
												/>
											}
										/>
									)}
								</For>
								<button
									type="button"
									onClick={() => {
										setOpen(false);
										setDialog({ type: "createPreset", open: true });
									}}
									class="flex aspect-video flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-ed-line-strong text-[12px] font-medium text-ed-text-2 outline-hidden transition-colors hover:border-ed-accent hover:text-ed-accent"
								>
									<IconLucidePlus class="size-4" />
									Save current style
								</button>
							</div>
						</section>
					</div>
				</KPopover.Content>
			</KPopover.Portal>
		</KPopover>
	);
}

function TemplateCard(props: {
	name: string;
	description: string;
	active: boolean;
	preview: JSX.Element;
	menu?: JSX.Element;
	onSelect: () => void;
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
			{props.menu}
		</div>
	);
}

function PresetMenu(props: {
	isDefault: boolean;
	onSaveHere: () => void;
	onSetDefault: () => void;
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
					<DropdownItem
						disabled={props.isDefault}
						onSelect={props.onSetDefault}
					>
						Set as default
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
