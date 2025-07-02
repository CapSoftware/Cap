import { Channel } from "@tauri-apps/api/core";
import { commands, ExportSettings, FramesRendered } from "./tauri";

export async function exportVideo(
  projectPath: string,
  settings: ExportSettings,
  onProgress: (progress: FramesRendered) => void
) {
  const progress = new Channel<FramesRendered>((e) => {
    onProgress(e);
  });
  return await commands.exportVideo(projectPath, progress, settings);
}
