import { closeMainWindow } from "@raycast/api";
import { executeDeepLink } from "./utils";

export default async function Command() {
  await closeMainWindow();
  
  await executeDeepLink(
    { stop_recording: null },
    "Recording stopped",
    "Failed to stop recording"
  );
}
