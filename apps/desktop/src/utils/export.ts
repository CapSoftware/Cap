import { Channel } from "@tauri-apps/api/core";
import { commands, type ExportSettings, type FramesRendered } from "./tauri";

export async function beginExportSessionGuard() {
	await commands.beginExportSession();
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		await commands.endExportSession().catch((error) => {
			console.error("Failed to release export session guard", error);
		});
	};
}

export function createExportTask(
	projectPath: string,
	settings: ExportSettings,
	onProgress: (progress: FramesRendered) => void,
) {
	const progress = new Channel<FramesRendered>((e) => {
		onProgress(e);
	});
	let closed = false;
	const cancel = () => {
		if (closed) return;
		closed = true;
		const internals = (
			globalThis as {
				__TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void };
			}
		).__TAURI_INTERNALS__;
		internals?.unregisterCallback?.(progress.id);
	};
	const promise = commands
		.exportVideo(projectPath, progress, settings)
		.finally(cancel);
	return { promise, cancel };
}

export function createExportToFileTask(
	projectPath: string,
	settings: ExportSettings,
	fileName: string,
	fileType: string,
	onProgress: (progress: FramesRendered) => void,
) {
	const progress = new Channel<FramesRendered>((e) => {
		onProgress(e);
	});
	let closed = false;
	const cancel = () => {
		if (closed) return;
		closed = true;
		const internals = (
			globalThis as {
				__TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void };
			}
		).__TAURI_INTERNALS__;
		internals?.unregisterCallback?.(progress.id);
	};
	const promise = (async () => {
		const releaseExportSession = await beginExportSessionGuard();
		try {
			const savePath = await commands.saveFileDialog(fileName, fileType);
			if (!savePath) throw new Error("Save dialog cancelled");

			const outputPath = await commands.exportVideo(
				projectPath,
				progress,
				settings,
			);
			await commands.copyFileToPath(outputPath, savePath);
			return savePath;
		} finally {
			await releaseExportSession();
		}
	})().finally(cancel);
	return { promise, cancel };
}

export async function exportVideoToFile(
	projectPath: string,
	settings: ExportSettings,
	fileName: string,
	fileType: string,
	onStart: () => void,
	onCopying: () => void,
	onProgress: (progress: FramesRendered) => void,
) {
	const releaseExportSession = await beginExportSessionGuard();
	try {
		const savePath = await commands.saveFileDialog(fileName, fileType);
		if (!savePath) throw new Error("Save dialog cancelled");

		onStart();
		const videoPath = await exportVideo(projectPath, settings, onProgress);
		onCopying();
		await commands.copyFileToPath(videoPath, savePath);
		return savePath;
	} finally {
		await releaseExportSession();
	}
}

export async function exportVideo(
	projectPath: string,
	settings: ExportSettings,
	onProgress: (progress: FramesRendered) => void,
) {
	const { promise } = createExportTask(projectPath, settings, onProgress);
	return await promise;
}
