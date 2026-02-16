import { closeMainWindow } from "@raycast/api";
import { executeDeepLink } from "./utils";

export default async function Command() {
  await closeMainWindow();
  
  await executeDeepLink(
    { toggle_camera: null },
    "Camera toggled",
    "Failed to toggle camera"
  );
}
