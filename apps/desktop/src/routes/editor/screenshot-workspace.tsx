import { remove, writeFile } from "@tauri-apps/plugin-fs";
import { createSignal } from "solid-js";
import toast from "solid-toast";
import { commands, type ImageDrawingCommit } from "~/utils/tauri";
import {
	ScreenshotEditorProvider,
	useScreenshotEditorContext,
} from "../screenshot-editor/context";
import { Editor as ScreenshotDrawingEditor } from "../screenshot-editor/Editor";
import type { ScreenshotSidebarAction } from "../screenshot-editor/screenshot-sidebar";
import { canvasToBlob } from "../screenshot-editor/screenshotExport";
import { useScreenshotExport } from "../screenshot-editor/useScreenshotExport";

function ImageDrawingActions(props: {
	imageIndex: number;
	onExit: () => Promise<boolean>;
	onCommit?: (commit: ImageDrawingCommit) => void;
	saving: () => boolean;
	setSaving: (value: boolean) => void;
}) {
	const { editorInstance } = useScreenshotEditorContext();
	const { renderExportCanvas } = useScreenshotExport();
	const apply = async () => {
		if (props.saving() || !editorInstance()) return;
		props.setSaving(true);
		let tempPath: string | undefined;
		try {
			const canvas = await renderExportCanvas();
			const blob = await canvasToBlob(canvas, "image/png");
			const bytes = new Uint8Array(await blob.arrayBuffer());
			tempPath = await commands.imageDrawingTempPath();
			await writeFile(tempPath, bytes);
			const commit = await commands.commitImageDrawing(
				props.imageIndex,
				tempPath,
			);
			props.onCommit?.(commit);
			if (await props.onExit()) toast.success("Drawing added to image track");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			if (tempPath) void remove(tempPath).catch(() => {});
			props.setSaving(false);
		}
	};
	return (
		<div class="flex gap-2">
			<button
				type="button"
				class="flex-1 rounded-lg bg-ed-ctl px-3 py-2 text-xs text-ed-text-2 hover:bg-ed-ctl-hover"
				disabled={props.saving()}
				onClick={() => void props.onExit()}
			>
				Cancel
			</button>
			<button
				type="button"
				class="flex-1 rounded-lg bg-ed-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
				disabled={props.saving() || !editorInstance()}
				onClick={() => void apply()}
			>
				{props.saving() ? "Applying…" : "Apply drawing"}
			</button>
		</div>
	);
}

export default function ScreenshotWorkspace(props: {
	imageDrawingIndex?: number;
	onExit?: () => void;
	onCommit?: (commit: ImageDrawingCommit) => void;
	initialAction?: ScreenshotSidebarAction;
}) {
	const [saving, setSaving] = createSignal(false);
	const exit = async () => {
		try {
			await commands.closeImageDrawingInstance();
			props.onExit?.();
			return true;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
			return false;
		}
	};
	return (
		<ScreenshotEditorProvider imageDrawingIndex={props.imageDrawingIndex}>
			<div class="relative flex h-full w-full min-h-0 flex-col">
				<ScreenshotDrawingEditor
					imageDrawingMode={props.imageDrawingIndex !== undefined}
					sidebarLayout
					initialAction={props.initialAction}
					onBack={
						props.imageDrawingIndex !== undefined
							? () => void exit()
							: undefined
					}
					backDisabled={saving()}
					sidebarFooter={
						props.imageDrawingIndex !== undefined && props.onExit ? (
							<ImageDrawingActions
								imageIndex={props.imageDrawingIndex}
								onExit={exit}
								onCommit={props.onCommit}
								saving={saving}
								setSaving={setSaving}
							/>
						) : undefined
					}
				/>
			</div>
		</ScreenshotEditorProvider>
	);
}
