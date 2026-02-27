import { open, showToast, Toast } from "@raycast/api";

const DEEPLINK_SCHEME = "cap-desktop";

/**
 * Build a Cap deeplink URL for the given action.
 *
 * Format: cap-desktop://action?value=<json-encoded action>
 */
export function buildDeepLink(action: Record<string, unknown>): string {
  const json = JSON.stringify(action);
  return `${DEEPLINK_SCHEME}://action?value=${encodeURIComponent(json)}`;
}

/**
 * Open a Cap deeplink and show appropriate toast feedback.
 */
export async function executeDeepLink(
  action: Record<string, unknown>,
  successMessage: string,
): Promise<void> {
  const url = buildDeepLink(action);

  try {
    await open(url);
    await showToast({ style: Toast.Style.Success, title: successMessage });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to communicate with Cap",
      message: String(error),
    });
  }
}
