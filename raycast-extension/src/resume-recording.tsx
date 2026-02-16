import { closeMainWindow } from "@raycast/api";
import { executeDeepLink } from "./utils";

export default async function Command() {
  await closeMainWindow();
  
  await executeDeepLink(
    { resume_recording: null },
    "Recording resumed",
    "Failed to resume recording"
  );
}
