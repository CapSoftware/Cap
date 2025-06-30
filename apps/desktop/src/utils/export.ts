import { Channel } from "@tauri-apps/api/core";
import {
  commands,
  ExportFormat,
  ExportSettings,
  FramesRendered,
} from "./tauri";

export async function exportVideo(
  projectPath: string,
  settings: ExportSettings,
  format: ExportFormat,
  onProgress: (progress: FramesRendered) => void
) {
  const progress = new Channel<FramesRendered>((e) => {
    onProgress(e);
  });
  return await commands.exportVideo(projectPath, progress, settings, format);
}
