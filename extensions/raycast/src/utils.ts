import { open, showToast, Toast } from "@raycast/api";

export async function sendDeepLink(action: Record<string, unknown>) {
  const value = encodeURIComponent(JSON.stringify(action));
  const url = `cap://action?value=${value}`;
  try {
    await open(url);
  } catch {
    await showToast({
      style: Toast.Style.Failure,
      title: "Cap Not Running",
      message: "Please open Cap and try again",
    });
  }
}
