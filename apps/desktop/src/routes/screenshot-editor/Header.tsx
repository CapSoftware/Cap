import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { remove } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import { createEffect, onCleanup, Suspense } from "solid-js";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";
import IconCapCrop from "~icons/cap/crop";
import IconCapTrash from "~icons/cap/trash";
import IconLucideCopy from "~icons/lucide/copy";
import IconLucideFolder from "~icons/lucide/folder";
import IconLucideMoreHorizontal from "~icons/lucide/more-horizontal";
import IconLucideSave from "~icons/lucide/save";
import { AnnotationTools } from "./AnnotationTools";
import { useScreenshotEditorContext } from "./context";
import { AspectRatioSelect } from "./popovers/AspectRatioSelect";
import { BackgroundSettingsPopover } from "./popovers/BackgroundSettingsPopover";
import { BorderPopover } from "./popovers/BorderPopover";
import { PaddingPopover } from "./popovers/PaddingPopover";
import { RoundingPopover } from "./popovers/RoundingPopover";
import { ShadowPopover } from "./popovers/ShadowPopover";
import {
	DropdownItem,
	EditorButton,
	MenuItemList,
	PopperContent,
	topSlideAnimateClasses,
} from "./ui";
import { useScreenshotExport } from "./useScreenshotExport";

export function Header() {
	const ctx = useScreenshotEditorContext();
	const { setDialog, project, latestFrame } = ctx;
	const path = () => ctx.editorInstance()?.path ?? "";

	const { exportImage, isExporting } = useScreenshotExport();

	createEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.isContentEditable)
			) {
				return;
			}

			if (!e.metaKey && !e.ctrlKey) return;
			const key = e.key.toLowerCase();
			if (key === "c") {
				e.preventDefault();
				if (!isExporting()) exportImage("clipboard");
			} else if (key === "s") {
				e.preventDefault();
				if (!isExporting()) exportImage("file");
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
	});

	const cropDialogHandler = () => {
		const frame = latestFrame();
		const frameWidth = frame?.data?.width ?? 0;
		const frameHeight = frame?.data?.height ?? 0;
		setDialog({
			open: true,
			type: "crop",
			originalSize: { x: frameWidth, y: frameHeight },
			currentCrop: project.background.crop,
		});
	};

	return (
		<div
			data-tauri-drag-region
			class="flex relative flex-row items-center w-full h-14 px-4 border-b border-gray-3 bg-gray-1 dark:bg-gray-2 shrink-0 z-20 gap-4 justify-between"
		>
			<div class="flex items-center gap-4">
				{ostype() === "macos" && <div class="w-14" />}
			</div>

			<div class="flex items-center gap-2 absolute left-1/2 -translate-x-1/2">
				<AspectRatioSelect />
				<EditorButton
					tooltipText="Crop Image"
					onClick={cropDialogHandler}
					leftIcon={<IconCapCrop class="size-4" />}
				/>
				<div class="w-px h-6 bg-gray-4 mx-1" />
				<AnnotationTools />
				<div class="w-px h-6 bg-gray-4 mx-1" />
				<BackgroundSettingsPopover />
				<PaddingPopover />
				<RoundingPopover />
				<ShadowPopover />
				<BorderPopover />
			</div>

			<div
				class={cx(
					"flex flex-row items-center gap-2",
					ostype() !== "windows" && "pr-2",
				)}
			>
				<div class="w-px h-6 bg-gray-4 mx-1" />

				<EditorButton
					onClick={() => {
						exportImage("clipboard");
					}}
					tooltipText="Copy to Clipboard"
					disabled={isExporting()}
					leftIcon={<IconLucideCopy class="w-4" />}
				/>

				<EditorButton
					tooltipText="Save"
					onClick={() => exportImage("file")}
					disabled={isExporting()}
					leftIcon={<IconLucideSave class="size-4" />}
				/>

				<DropdownMenu gutter={8} placement="bottom-end">
					<EditorButton<typeof DropdownMenu.Trigger>
						as={DropdownMenu.Trigger}
						tooltipText="More Actions"
						leftIcon={<IconLucideMoreHorizontal class="size-4" />}
					/>
					<DropdownMenu.Portal>
						<Suspense>
							<PopperContent<typeof DropdownMenu.Content>
								as={DropdownMenu.Content}
								class={cx("min-w-[200px]", topSlideAnimateClasses)}
							>
								<MenuItemList<typeof DropdownMenu.Group>
									as={DropdownMenu.Group}
									class="p-1"
								>
									<DropdownItem
										onSelect={() => {
											revealItemInDir(path());
										}}
									>
										<IconLucideFolder class="size-4 text-gray-11" />
										<span>Open Folder</span>
									</DropdownItem>
									<DropdownItem
										onSelect={async () => {
											if (
												await ask(
													"Are you sure you want to delete this screenshot?",
												)
											) {
												await remove(path());
												await getCurrentWindow().close();
											}
										}}
									>
										<IconCapTrash class="size-4 text-gray-11" />
										<span>Delete</span>
									</DropdownItem>
								</MenuItemList>
							</PopperContent>
						</Suspense>
					</DropdownMenu.Portal>
				</DropdownMenu>

				{ostype() === "windows" && <CaptionControlsWindows11 />}
			</div>
		</div>
	);
}
