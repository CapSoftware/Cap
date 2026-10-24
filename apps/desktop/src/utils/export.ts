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
	const closeProgress = () => {
		if (closed) return;
		closed = true;
		const internals = (
			globalThis as {
				__TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void };
			}
		).__TAURI_INTERNALS__;
		internals?.unregisterCallback?.(progress.id);
	};
	const cancel = () => {
		if (closed) return;
		void cancelCurrentWindowExports();
		closeProgress();
	};
	const promise = commands
		.exportVideo(projectPath, progress, settings)
		.finally(closeProgress);
	return { promise, cancel };
}

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
	const progress = new Channel<FramesRendered>((e) => {
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
		const internals = (
			globalThis as {
				__TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void };
			}
		).__TAURI_INTERNALS__;
		internals?.unregisterCallback?.(progress.id);
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

export async function exportVideoToFile(
	projectPath: string,
	settings: ExportSettings,
	fileName: string,
	fileType: string,
	onStart: () => void,
	onCopying: () => void,
	onProgress: (progress: FramesRendered) => void,
) {
	const { promise } = createExportToFileTask(
		projectPath,
		settings,
		fileName,
		fileType,
		onProgress,
		onStart,
		onCopying,
	);
	return await promise;
}

export async function exportVideo(
	projectPath: string,
	settings: ExportSettings,
	onProgress: (progress: FramesRendered) => void,
) {
	const { promise } = createExportTask(projectPath, settings, onProgress);
	return await promise;
}
