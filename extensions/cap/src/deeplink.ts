import { Toast, open, showToast } from "@raycast/api";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Windows: `open()` can fail to hand off custom protocols; `start` uses ShellExecute like Explorer. */
async function openCustomProtocolUrl(url: string): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("cmd.exe", ["/c", "start", "", url], { windowsHide: true });
    return;
  }
  await open(url);
}

export async function runCapDeeplink(body: Record<string, unknown>): Promise<void> {
  const value = encodeURIComponent(JSON.stringify(body));
  const url = `cap-desktop://action?value=${value}`;
  try {
    await openCustomProtocolUrl(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await showToast({
      style: Toast.Style.Failure,
      title: "Cap deeplink failed",
      message: message.length > 0 ? message : "Could not open cap-desktop URL. Is Cap installed?",
    });
    throw error;
  }
}
