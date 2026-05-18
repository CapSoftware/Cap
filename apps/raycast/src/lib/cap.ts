import { closeMainWindow, open, showHUD } from "@raycast/api";

const CAP_DEEPLINK_ACTION_HOST = "action";

export async function dispatchAction(action: unknown) {
  const value = encodeURIComponent(JSON.stringify(action));
  const url = `cap-desktop://${CAP_DEEPLINK_ACTION_HOST}?value=${value}`;

  await open(url);
  await closeMainWindow();
}

export async function fireSimpleAction(action: string) {
  await dispatchAction({ type: action });
  await showHUD(`Cap: ${action}`);
}
