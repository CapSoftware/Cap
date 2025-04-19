import { Channel } from "@tauri-apps/api/core";
import { commands, ExportSettings, FramesRendered } from "./tauri";
import { trackEvent } from "./analytics";

export async function exportVideo(
  projectPath: string,
  settings: ExportSettings,
  onProgress: (progress: FramesRendered) => void
) {
  const progress = new Channel<FramesRendered>();

  progress.onmessage = onProgress;

  return await commands.exportVideo(projectPath, progress, settings);
}
