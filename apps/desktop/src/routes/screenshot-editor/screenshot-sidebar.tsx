import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { remove } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { createEffect, type JSX, onCleanup, Show } from "solid-js";
import IconCapCrop from "~icons/cap/crop";
import IconCapTrash from "~icons/cap/trash";
import IconLucideArrowLeft from "~icons/lucide/arrow-left";
import IconLucideCopy from "~icons/lucide/copy";
import IconLucideFolder from "~icons/lucide/folder";
import IconLucideLink from "~icons/lucide/link";
import IconLucideMoreHorizontal from "~icons/lucide/more-horizontal";
import IconLucideSave from "~icons/lucide/save";
import { AnnotationConfigBar } from "./AnnotationConfig";
import { AnnotationTools } from "./AnnotationTools";
import {
	type ScreenshotEditorTool,
	useScreenshotEditorContext,
} from "./context";
import { LayersPanel } from "./LayersPanel";
import { AspectRatioSelect } from "./popovers/AspectRatioSelect";
import { BackgroundSettingsPopover } from "./popovers/BackgroundSettingsPopover";
import { BorderPopover } from "./popovers/BorderPopover";
import { PaddingPopover } from "./popovers/PaddingPopover";
import { RoundingPopover } from "./popovers/RoundingPopover";
import { ShadowPopover } from "./popovers/ShadowPopover";
import { useScreenshotExport } from "./useScreenshotExport";

export type ScreenshotSidebarAction =
	| { type: "tool"; tool: ScreenshotEditorTool }
	| {
			type: "appearance";
			panel:
				| "aspect"
				| "crop"
				| "background"
				| "padding"
				| "rounding"
				| "shadow"
				| "border";
	  };

export function ScreenshotSidebar(props: {
	initialAction?: ScreenshotSidebarAction;
	footer?: JSX.Element;
	onBack?: () => void;
	backDisabled?: boolean;
}) {
	const ctx = useScreenshotEditorContext();
	const {
		originalImageSize,
		isImageFileReady,
		isRenderReady,
		layersPanelOpen,
		setDialog,
		setActiveTool,
		setSelectedAnnotationId,
		setActivePopover,
	} = ctx;
	let initialActionApplied = false;
	const openCrop = () => {
		const size = originalImageSize();
		if (!size || !isImageFileReady()) return;
		setDialog({
			open: true,
			type: "crop",
			originalSize: { x: size.width, y: size.height },
			currentCrop: ctx.project.background.crop,
		});
	};
	createEffect(() => {
		if (!isRenderReady() || initialActionApplied || !props.initialAction)
			return;
		const action = props.initialAction;
		if (
			action.type === "appearance" &&
			action.panel === "crop" &&
			!isImageFileReady()
		)
			return;
		initialActionApplied = true;
		if (action.type === "tool") {
			setActiveTool(action.tool);
			if (action.tool !== "select") setSelectedAnnotationId(null);
		} else if (action.panel === "crop") {
			openCrop();
		} else if (action.panel !== "aspect") {
			setActivePopover(action.panel);
		}
	});

	return (
		<aside class="flex h-full w-104 min-w-104 flex-none flex-col overflow-hidden rounded-xl bg-ed-card text-ed-text-1 shadow-ed-card">
			<div class="flex h-[46px] shrink-0 items-center gap-2 border-b border-ed-line px-3">
				<Show when={props.onBack}>
					<button
						type="button"
						aria-label="Back to editor"
						disabled={props.backDisabled}
						class="flex size-8 items-center justify-center rounded-lg text-ed-text-2 transition-colors hover:bg-ed-ctl hover:text-ed-text-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ed-accent disabled:opacity-40"
						onClick={props.onBack}
					>
						<IconLucideArrowLeft class="size-4" />
					</button>
				</Show>
				<span class="shrink-0 text-[13px] font-semibold">Edit image</span>
				<span class="ml-auto truncate text-[12px] text-ed-text-3">
					{ctx.prettyName}
				</span>
			</div>
			<div class="custom-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
				<section class="flex flex-col gap-2.5">
					<h3 class="text-[12px] font-medium text-ed-text-2">Annotate</h3>
					<AnnotationTools sidebar />
					<Show when={ctx.selectedAnnotationId()}>
						<div>
							<AnnotationConfigBar sidebar />
						</div>
					</Show>
					<Show when={layersPanelOpen()}>
						<div>
							<LayersPanel sidebar />
						</div>
					</Show>
				</section>
				<section class="mt-5 flex flex-col gap-2.5">
					<h3 class="text-[12px] font-medium text-ed-text-2">Appearance</h3>
					<div class="flex items-center justify-between rounded-xl bg-ed-ctl px-3 py-2">
						<span class="text-[12px] font-medium text-ed-text-2">
							Aspect ratio
						</span>
						<AspectRatioSelect
							initialOpen={
								props.initialAction?.type === "appearance" &&
								props.initialAction.panel === "aspect"
							}
						/>
					</div>
					<div class="grid grid-cols-3 gap-2">
						<AppearanceOption label="Crop">
							<button
								type="button"
								aria-label="Crop image"
								class="flex size-8 items-center justify-center rounded-lg bg-ed-ctl text-ed-text-2 transition-colors hover:bg-ed-ctl-hover disabled:opacity-40"
								disabled={!originalImageSize() || !isImageFileReady()}
								onClick={openCrop}
							>
								<IconCapCrop class="size-4" />
							</button>
						</AppearanceOption>
						<AppearanceOption label="Background">
							<BackgroundSettingsPopover />
						</AppearanceOption>
						<AppearanceOption label="Padding">
							<PaddingPopover />
						</AppearanceOption>
						<AppearanceOption label="Corners">
							<RoundingPopover />
						</AppearanceOption>
						<AppearanceOption label="Shadow">
							<ShadowPopover />
						</AppearanceOption>
						<AppearanceOption label="Border">
							<BorderPopover />
						</AppearanceOption>
					</div>
				</section>
			</div>
			<div class="border-t border-ed-line p-4">
				{props.footer ?? <ScreenshotExportActions />}
			</div>
		</aside>
	);
}

function AppearanceOption(props: { label: string; children: JSX.Element }) {
	return (
		<div class="relative flex h-[68px] min-w-0 flex-col items-center justify-end rounded-xl border border-transparent bg-ed-ctl pb-3 text-ed-text-2 transition-colors hover:border-ed-line hover:bg-ed-ctl-hover [&>button]:absolute [&>button]:inset-0 [&>button]:!h-full [&>button]:!w-full [&>button]:!justify-center [&>button]:!bg-transparent [&>button]:pb-5 [&>button]:text-ed-text-2">
			{props.children}
			<span class="pointer-events-none relative z-10 text-center text-[11px] font-medium leading-tight text-ed-text-2">
				{props.label}
			</span>
		</div>
	);
}

function ScreenshotExportActions() {
	const { exportImage, isExporting } = useScreenshotExport();
	const { editorInstance, selectedAnnotationId } = useScreenshotEditorContext();
	const path = () => editorInstance()?.path ?? "";
	createEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || !(event.metaKey || event.ctrlKey)) return;
			const target = event.target as HTMLElement | null;
			if (
				target?.tagName === "INPUT" ||
				target?.tagName === "TEXTAREA" ||
				target?.isContentEditable
			)
				return;
			const key = event.key.toLowerCase();
			if (key === "c" && !selectedAnnotationId()) {
				const selection = window.getSelection();
				if (selection && !selection.isCollapsed && selection.toString()) return;
				event.preventDefault();
				if (!isExporting()) exportImage("clipboard");
			} else if (key === "s") {
				event.preventDefault();
				if (!isExporting()) exportImage("file");
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
	});
	return (
		<div class="grid grid-cols-4 gap-2">
			<button
				type="button"
				class="flex flex-col items-center gap-1 rounded-lg bg-ed-ctl px-2 py-2 text-[11px] text-ed-text-2 hover:bg-ed-ctl-hover disabled:opacity-40"
				disabled={isExporting()}
				onClick={() => exportImage("clipboard")}
			>
				<IconLucideCopy class="size-4" />
				Copy
			</button>
			<button
				type="button"
				class="flex flex-col items-center gap-1 rounded-lg bg-ed-ctl px-2 py-2 text-[11px] text-ed-text-2 hover:bg-ed-ctl-hover disabled:opacity-40"
				disabled={isExporting()}
				onClick={() => exportImage("file")}
			>
				<IconLucideSave class="size-4" />
				Save
			</button>
			<button
				type="button"
				class="flex flex-col items-center gap-1 rounded-lg bg-ed-ctl px-2 py-2 text-[11px] text-ed-text-2 hover:bg-ed-ctl-hover disabled:opacity-40"
				disabled={isExporting()}
				onClick={() => exportImage("share")}
			>
				<IconLucideLink class="size-4" />
				Share
			</button>
			<DropdownMenu placement="top-end">
				<DropdownMenu.Trigger
					class="flex flex-col items-center gap-1 rounded-lg bg-ed-ctl px-2 py-2 text-[11px] text-ed-text-2 hover:bg-ed-ctl-hover disabled:opacity-40"
					disabled={isExporting()}
				>
					<IconLucideMoreHorizontal class="size-4" />
					More
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content class="z-50 min-w-44 rounded-lg border border-ed-line bg-ed-card p-1 shadow-ed-card">
						<DropdownMenu.Item
							class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs text-ed-text-2 outline-hidden hover:bg-ed-ctl-hover"
							onSelect={() => void revealItemInDir(path())}
						>
							<IconLucideFolder class="size-4" />
							Open folder
						</DropdownMenu.Item>
						<DropdownMenu.Item
							class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs text-ed-text-2 outline-hidden hover:bg-ed-ctl-hover"
							onSelect={() =>
								void (async () => {
									if (
										await ask(
											"Are you sure you want to delete this screenshot?",
										)
									) {
										await remove(path());
										await getCurrentWindow().close();
									}
								})()
							}
						>
							<IconCapTrash class="size-4" />
							Delete screenshot
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu>
		</div>
	);
}
