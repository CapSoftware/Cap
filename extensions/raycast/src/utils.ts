import { open, showHUD } from "@raycast/api";

const CAP_DEEPLINK_SCHEME = "cap-desktop://";

/**
 * Send a deep link action to the Cap desktop app.
 * URL format: cap-desktop://action?value=<JSON-encoded serde enum>
 *
 * The `value` parameter is the serde-serialized DeepLinkAction enum.
 * For unit variants: `"stop_recording"` (just a string)
 * For struct variants: `{"start_recording": { ... }}`
 */
export async function sendDeepLink(value: string | Record<string, unknown>): Promise<void> {
  const encodedValue = encodeURIComponent(JSON.stringify(value));
  const url = `${CAP_DEEPLINK_SCHEME}action?value=${encodedValue}`;
  await open(url);
}

/**
 * Open the Cap app without a specific action.
 */
export async function openCap(): Promise<void> {
  await open(CAP_DEEPLINK_SCHEME);
}

/**
 * Get the Cap recordings directory path.
 * Cap (Tauri) stores recordings under the app data directory.
 */
export function getRecordingsDir(): string {
  const home = process.env.HOME || "~";
  return `${home}/Library/Application Support/so.cap.desktop/recordings`;
}
