import { open, showHUD, showToast, Toast } from "@raycast/api";

export const CAP_SCHEME = "cap";

/**
 * Build a `cap://` deep-link URL.
 */
export function buildDeeplink(route: string, params?: Record<string, string>): string {
  const base = `${CAP_SCHEME}://${route}`;
  if (!params || Object.keys(params).length === 0) return base;
  const qs = new URLSearchParams(params).toString();
  return `${base}?${qs}`;
}

/**
 * Open a `cap://` deep-link and show HUD feedback.
 */
export async function openDeeplink(
  route: string,
  params?: Record<string, string>,
  hudMessage?: string
): Promise<void> {
  const url = buildDeeplink(route, params);
  try {
    await open(url);
    if (hudMessage) {
      await showHUD(hudMessage);
    }
  } catch (err) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Cap not found",
      message: "Make sure Cap is installed and running.",
    });
    throw err;
  }
}
