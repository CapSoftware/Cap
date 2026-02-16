import { closeMainWindow } from "@raycast/api";
import { executeDeepLink } from "./utils";

export default async function Command() {
  await closeMainWindow();
  
  await executeDeepLink(
    { pause_recording: null },
    "Recording paused",
    "Failed to pause recording"
  );
}
