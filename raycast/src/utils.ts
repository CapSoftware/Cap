import { open, showHUD } from "@raycast/api";

const DEEPLINK_SCHEME = "cap-desktop";

type UnitDeepLinkAction =
  | "stop_recording"
  | "pause_recording"
  | "resume_recording"
  | "toggle_pause_recording";

type DeepLinkAction = UnitDeepLinkAction | Record<string, unknown>;

export async function executeDeepLink(action: DeepLinkAction, hudMessage: string) {
  const encodedValue = encodeURIComponent(JSON.stringify(action));
  const url = `${DEEPLINK_SCHEME}://action?value=${encodedValue}`;

  try {
    await open(url);
    await showHUD(hudMessage);
  } catch {
    await showHUD("Failed to communicate with Cap. Is Cap running?");
  }
}
