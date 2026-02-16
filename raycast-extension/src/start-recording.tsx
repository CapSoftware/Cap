import { closeMainWindow, showToast, Toast } from "@raycast/api";
import { executeDeepLink } from "./utils";

export default async function Command() {
  await closeMainWindow();

  await showToast({
    style: Toast.Style.Animated,
    title: "Starting recording...",
    message: "This will use your default Cap settings",
  });

  // Note: This is a simplified version that would need the user to configure
  // their default recording settings in Cap itself. A more advanced version
  // could present a form to select screen/window and recording mode.
  await showToast({
    style: Toast.Style.Failure,
    title: "Start Recording",
    message: "Please use Cap app to start recording with specific settings. Use other commands to control active recordings.",
  });
}
