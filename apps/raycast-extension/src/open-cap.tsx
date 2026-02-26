import { showHUD, showToast, Toast } from "@raycast/api";
import { openCap } from "./utils/cap";

export default async function OpenCap() {
  try {
    await openCap();
    await showHUD("Opening Cap...");
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to open Cap",
      message: String(error),
    });
  }
}
