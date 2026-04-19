import { Toast, open, showToast } from "@raycast/api";

export async function runCapDeeplink(body: Record<string, unknown>): Promise<void> {
  const value = encodeURIComponent(JSON.stringify(body));
  const url = `cap-desktop://action?value=${value}`;
  try {
    await open(url);
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
