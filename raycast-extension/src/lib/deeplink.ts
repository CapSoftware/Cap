import { open, showHUD } from "@raycast/api";

/**
 * Triggers a Cap deeplink action using the cap-desktop:// URL scheme.
 */
export async function triggerDeeplink(action: object): Promise<void> {
  const encoded = encodeURIComponent(JSON.stringify(action));
  const url = `cap-desktop://action?value=${encoded}`;
  await open(url);
}
