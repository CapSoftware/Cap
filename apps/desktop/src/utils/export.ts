import { Channel, invoke } from "@tauri-apps/api/core";
import { commands, type ExportSettings, type FramesRendered } from "./tauri";

export async function beginExportSessionGuard() {
	await invoke("begin_export_session");
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		await invoke("end_export_session").catch((error) => {
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
	const promise = invoke<string>("export_video_to_file", {
		projectPath,
		progress,
		settings,
		fileName,
		fileType,
	}).finally(cancel);
	return { promise, cancel };
}

export async function exportVideo(
	projectPath: string,
	settings: ExportSettings,
	onProgress: (progress: FramesRendered) => void,
) {
	const { promise } = createExportTask(projectPath, settings, onProgress);
	return await promise;
}
