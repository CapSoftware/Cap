import { open, showHUD } from "@raycast/api";

const SCHEME = "cap-desktop";

type DeepLinkAction = string | Record<string, unknown>;

/**
 * Build a Cap deeplink URL.
 *
 * Actions are sent as: cap-desktop://action?value=<json>
 *
 * Unit variants (e.g. StopRecording) serialize as a plain string: "stop_recording"
 * Struct variants serialize as: {"start_recording": {...}}
 */
export function buildDeepLink(action: DeepLinkAction): string {
  const json = JSON.stringify(action);
  return `${SCHEME}://action?value=${encodeURIComponent(json)}`;
}

/**
 * Open a Cap deeplink and show a HUD message.
 * Shows an error HUD if Cap is not running or the deeplink fails.
 */
export async function triggerDeepLink(
  action: DeepLinkAction,
  hudMessage: string,
): Promise<void> {
  const url = buildDeepLink(action);
  try {
    await open(url);
    await showHUD(hudMessage);
  } catch {
    await showHUD("❌ Failed — is Cap running?");
  }
}
