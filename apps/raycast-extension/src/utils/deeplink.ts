/**
 * Deeplink helpers for the Cap Raycast extension.
 *
 * Builds cap:// URLs and opens them so Cap (the Electron app) handles them.
 */

import { open, showHUD, showToast, Toast } from "@raycast/api";

const CAP_SCHEME = "cap";

/**
 * Build a cap:// deeplink URL.
 *
 * @param action  e.g. "record/start", "settings/camera"
 * @param params  optional query-string params, e.g. { deviceId: "abc" }
 */
export function buildDeeplink(
  action: string,
  params: Record<string, string> = {}
): string {
  // URL shape:  cap://<first-segment>/<rest>?key=value
  // e.g.        cap://record/start
  //             cap://settings/camera?deviceId=Built-in%20FaceTime%20HD
  const parts = action.split("/");
  const host = parts[0];
  const path = parts.slice(1).join("/");

  const url = new URL(`${CAP_SCHEME}://${host}${path ? `/${path}` : ""}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return url.toString();
}

/**
 * Open a Cap deeplink and show a HUD confirmation message.
 *
 * @param action   deeplink action string
 * @param hudMsg   message shown to the user on success
 * @param params   optional query params
 */
export async function triggerDeeplink(
  action: string,
  hudMsg: string,
  params: Record<string, string> = {}
): Promise<void> {
  const url = buildDeeplink(action, params);

  try {
    await open(url);
    await showHUD(hudMsg);
  } catch (err) {
    console.error("[cap-raycast] Failed to open deeplink:", url, err);
    await showToast({
      style: Toast.Style.Failure,
      title: "Cap not available",
      message:
        "Make sure Cap is running. Download at cap.so",
    });
  }
}
