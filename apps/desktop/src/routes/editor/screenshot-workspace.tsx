import { remove, writeFile } from "@tauri-apps/plugin-fs";
import { createSignal, Show } from "solid-js";
import toast from "solid-toast";
import { commands, type ImageDrawingCommit } from "~/utils/tauri";
import {
	ScreenshotEditorProvider,
	useScreenshotEditorContext,
} from "../screenshot-editor/context";
import { Editor as ScreenshotDrawingEditor } from "../screenshot-editor/Editor";
import { canvasToBlob } from "../screenshot-editor/screenshotExport";
import { useScreenshotExport } from "../screenshot-editor/useScreenshotExport";

function ImageDrawingActions(props: {
	imageIndex: number;
	onExit: () => void;
	onCommit?: (commit: ImageDrawingCommit) => void;
}) {
	const { editorInstance } = useScreenshotEditorContext();
	const { renderExportCanvas } = useScreenshotExport();
	const [saving, setSaving] = createSignal(false);
	const exit = async () => {
		await commands.closeImageDrawingInstance();
		props.onExit();
	};
	const apply = async () => {
		if (saving() || !editorInstance()) return;
		setSaving(true);
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
			await exit();
			toast.success("Drawing added to image track");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			if (tempPath) void remove(tempPath).catch(() => {});
			setSaving(false);
		}
	};
	return (
		<div class="absolute bottom-4 right-4 z-50 flex gap-2 rounded-lg border border-ed-line bg-ed-card p-2 shadow-ed-card">
			<button
				type="button"
				class="rounded-md px-3 py-2 text-xs text-ed-text-2 hover:bg-ed-ctl-hover"
				disabled={saving()}
				onClick={() => void exit()}
			>
				Cancel
			</button>
			<button
				type="button"
				class="rounded-md bg-ed-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
				disabled={saving() || !editorInstance()}
				onClick={() => void apply()}
			>
				{saving() ? "Applying…" : "Apply drawing"}
			</button>
		</div>
	);
}

export default function ScreenshotWorkspace(props: {
	imageDrawingIndex?: number;
	onExit?: () => void;
	onCommit?: (commit: ImageDrawingCommit) => void;
}) {
	return (
		<ScreenshotEditorProvider imageDrawingIndex={props.imageDrawingIndex}>
			<div class="relative flex h-full w-full min-h-0 flex-col">
				<ScreenshotDrawingEditor
					imageDrawingMode={props.imageDrawingIndex !== undefined}
				/>
				<Show when={props.imageDrawingIndex !== undefined && props.onExit}>
					<ImageDrawingActions
						imageIndex={props.imageDrawingIndex ?? 0}
						onExit={props.onExit ?? (() => {})}
						onCommit={props.onCommit}
					/>
				</Show>
			</div>
		</ScreenshotEditorProvider>
	);
}
