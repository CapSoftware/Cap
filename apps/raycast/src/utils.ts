import { getPreferenceValues, open, showToast, Toast } from "@raycast/api";

const DEEPLINK_SCHEME = "cap-desktop";

interface Preferences {
  displayName: string;
}

export function getDisplayName(): string {
  const { displayName } = getPreferenceValues<Preferences>();
  return displayName || "Main Display";
}

export function buildDeepLink(action: Record<string, unknown>): string {
  const json = JSON.stringify(action);
  return `${DEEPLINK_SCHEME}://action?value=${encodeURIComponent(json)}`;
}

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
