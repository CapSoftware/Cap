import { Toast, open, showToast } from "@raycast/api";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Windows: `open()` is flaky for custom schemes. `cmd /c start "" <url>` looks fine but **cmd expands
 * `%…%` in the whole line**, so `encodeURIComponent` JSON (`%22`, `%7B`, …) gets mangled before `start`
 * runs — Cap never sees a valid `value` query. `rundll32 url.dll,FileProtocolHandler` hands the URL
 * to the shell without that corruption.
 */
async function openCustomProtocolUrl(url: string): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true });
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
