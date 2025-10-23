import { Channel } from "@tauri-apps/api/core";
import { commands, type ExportSettings, type FramesRendered } from "./tauri";

export async function exportVideo(
	projectPath: string,
	settings: ExportSettings,
	onProgress: (progress: FramesRendered) => void,
) {
	const progress = new Channel<FramesRendered>((e) => {
		onProgress(e);
	});
	return await commands.exportVideo(projectPath, progress, settings, true); // TODO: Fix this last param
}
