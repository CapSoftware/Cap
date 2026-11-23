import { commands, EditorChannel } from "../../engine/editor-api";
import type { ExportSettings, FramesRendered } from "../../engine/types";

async function cancelCurrentWindowExports() {
	await commands.cancelCurrentWindowExports().catch((error) => {
		console.error("Failed to cancel export", error);
	});
}

export function createExportToFileTask(
	projectPath: string,
	settings: ExportSettings,
	fileName: string,
	fileType: string,
	onProgress: (progress: FramesRendered) => void,
	onStart?: () => void,
	onCopying?: () => void,
) {
	let started = false;
	let copying = false;
	let cancelled = false;
	const progress = new EditorChannel<FramesRendered>((e) => {
		if (!started) {
			started = true;
			onStart?.();
		}
		onProgress(e);
	});
	let closed = false;
	const closeProgress = () => {
		if (closed) return;
		closed = true;
		progress.close();
	};
	const cancel = () => {
		if (cancelled) return;
		cancelled = true;
		void cancelCurrentWindowExports();
		closeProgress();
	};
	const promise = commands
		.exportVideoToFile(projectPath, progress, settings, fileName, fileType)
		.then((savePath) => {
			if (cancelled) throw new Error("Export cancelled");
			if (!copying) {
				copying = true;
				onCopying?.();
			}
			return savePath;
		})
		.finally(closeProgress);
	return { promise, cancel };
}
