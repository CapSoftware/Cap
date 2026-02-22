import { open, closeMainWindow, showToast, Toast, getApplications } from "@raycast/api";

const CAP_BUNDLE_ID = "so.cap.desktop";
const CAP_SCHEME = "cap-desktop";

export async function isCapInstalled(): Promise<boolean> {
  const apps = await getApplications();
  return apps.some(app => app.bundleId === CAP_BUNDLE_ID);
}

export async function triggerCapAction(action: object): Promise<void> {
  const installed = await isCapInstalled();
  if (!installed) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Cap not installed",
      message: "Please install Cap from cap.so",
    });
    return;
  }

  const encoded = encodeURIComponent(JSON.stringify(action));
  const url = `${CAP_SCHEME}://action?value=${encoded}`;
  
  await closeMainWindow();
  await open(url);
}

export async function simpleCapAction(actionName: string): Promise<void> {
  const action = { [actionName]: null };
  await triggerCapAction(action);
}
