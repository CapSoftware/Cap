import { Channel, invoke } from "@tauri-apps/api/core";
import { commands, type ExportSettings, type FramesRendered } from "./tauri";

export function createExportTask(
	projectPath: string,
	settings: ExportSettings,
	onProgress: (progress: FramesRendered) => void,
) {
	if (!import.meta.env.DEV) {
		onProgress({ renderedCount: 0, totalFrames: 1, type: "FramesRendered" });
		return {
			cancel: () => {},
			promise: invoke<string>("export_video_no_progress", {
				projectPath,
				settings,
			}),
		};
	}

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

export async function exportVideo(
	projectPath: string,
	settings: ExportSettings,
	onProgress: (progress: FramesRendered) => void,
) {
	const { promise } = createExportTask(projectPath, settings, onProgress);
	return await promise;
}
