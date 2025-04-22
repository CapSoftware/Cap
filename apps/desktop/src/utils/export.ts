import { Channel } from "@tauri-apps/api/core";
import { commands, ExportSettings, FramesRendered } from "./tauri";
import type { CompressionQuality } from "./tauri";

export const COMPRESSION_QUALITY = {
  Studio: "Studio",
  Social: "Social",
  Web: "Web",
  WebLow: "WebLow"
} as const satisfies Record<string, CompressionQuality>;

export async function exportVideo(
  projectPath: string,
  settings: ExportSettings,
  onProgress: (progress: FramesRendered) => void
) {
  const progress = new Channel<FramesRendered>();
  progress.onmessage = onProgress;
  return await commands.exportVideo(projectPath, progress, settings);
}
