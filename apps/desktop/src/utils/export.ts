import { Channel } from "@tauri-apps/api/core";
import {
  commands,
  ExportCompression,
  ExportSettings,
  FramesRendered,
} from "./tauri";

export async function exportVideo(
  projectPath: string,
  settings: ExportSettings,
  onProgress: (progress: FramesRendered) => void
) {
  const progress = new Channel<FramesRendered>();
  progress.onmessage = onProgress;
  return await commands.exportVideo(projectPath, progress, settings);
}
