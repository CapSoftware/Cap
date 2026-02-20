import { closeMainWindow, open, showHUD } from "@raycast/api";

type DeepLinkAction = string | Record<string, unknown>;

export async function runDeepLinkAction(action: DeepLinkAction, successMessage: string) {
  const value = JSON.stringify(action);
  const deeplink = `cap-desktop://action?value=${encodeURIComponent(value)}`;
  await closeMainWindow();
  await open(deeplink);
  await showHUD(successMessage);
}
