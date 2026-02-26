import { showToast, Toast } from "@raycast/api";
import { sendDeepLink } from "./utils";

export default async function Command() {
  try {
    await sendDeepLink("open_settings", {
      page: null,
    });

    await showToast({
      style: Toast.Style.Success,
      title: "Opening Cap settings...",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to open settings",
      message: String(error),
    });
  }
}
