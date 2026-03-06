import { closeMainWindow, showToast, Toast } from "@raycast/api";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function toDeepLink(action: unknown) {
  const value = encodeURIComponent(JSON.stringify(action));
  return `cap-desktop://action?value=${value}`;
}

export async function dispatchAction(action: unknown) {
  const url = toDeepLink(action);
  await closeMainWindow();

  try {
    await execFileAsync("open", [url]);
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to trigger Cap",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  await showToast({
    style: Toast.Style.Success,
    title: "Sent to Cap",
  });
}

export async function dispatchSimpleAction(actionName: string) {
  await dispatchAction({ [actionName]: null });
}
