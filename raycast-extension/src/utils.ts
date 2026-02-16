import { exec } from "child_process";
import { promisify } from "util";
import { showToast, Toast } from "@raycast/api";

const execAsync = promisify(exec);

export interface DeepLinkAction {
  [key: string]: any;
}

/**
 * Execute a Cap deeplink action
 * @param action The action object to serialize and pass to Cap
 * @param successMessage Message to show on success
 * @param errorMessage Message to show on error
 */
export async function executeDeepLink(
  action: DeepLinkAction,
  successMessage: string,
  errorMessage: string
): Promise<void> {
  try {
    const actionJson = JSON.stringify(action);
    const encodedAction = encodeURIComponent(actionJson);
    const deeplinkUrl = `cap-desktop://action?value=${encodedAction}`;

    await showToast({
      style: Toast.Style.Animated,
      title: "Executing...",
    });

    await execAsync(`open "${deeplinkUrl}"`);

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
