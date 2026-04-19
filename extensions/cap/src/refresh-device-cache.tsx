import { Toast, closeMainWindow, showToast } from "@raycast/api";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCapDeeplink } from "./deeplink";

function cachePathHint(): string {
  if (process.platform === "win32") {
    const base = join(homedir(), "AppData", "Roaming");
    const devPath = join(base, "so.cap.desktop.dev", "raycast-device-cache.json");
    const prodPath = join(base, "so.cap.desktop", "raycast-device-cache.json");
    return (
      `tauri dev → ${devPath}\n` +
      `installed Cap → ${prodPath}\n` +
      `Whichever Cap.exe owns cap-desktop:// handles this (often the installer build, not dev).`
    );
  }
  const base = join(homedir(), "Library", "Application Support");
  const devPath = join(base, "so.cap.desktop.dev", "raycast-device-cache.json");
  const prodPath = join(base, "so.cap.desktop", "raycast-device-cache.json");
  return `dev → ${devPath}\nprod → ${prodPath}`;
}

export default async function main() {
  await runCapDeeplink({ refresh_raycast_device_cache: null });
  await showToast({
    style: Toast.Style.Success,
    title: "Cap: device cache refresh sent",
    message: cachePathHint(),
  });
  await closeMainWindow();
}
