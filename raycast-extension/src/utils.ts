import { execFile } from "child_process";
import { promisify } from "util";
import { showToast, Toast } from "@raycast/api";

const execFileAsync = promisify(execFile);

export type DeepLinkAction = Record<string, unknown>;

export async function executeDeepLink(
  action: DeepLinkAction,
  successMessage: string,
  errorMessage: string
): Promise<void> {
  try {
    const encodedAction = encodeURIComponent(JSON.stringify(action));
    const deeplinkUrl = `cap-desktop://action?value=${encodedAction}`;

    await showToast({
      style: Toast.Style.Animated,
      title: "Executing...",
    });

    await execFileAsync("open", [deeplinkUrl]);

    await showToast({
      style: Toast.Style.Success,
      title: successMessage,
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: errorMessage,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
