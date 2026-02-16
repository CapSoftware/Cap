import { closeMainWindow } from "@raycast/api";
import { executeDeepLink } from "./utils";

export default async function Command() {
  await closeMainWindow();
  
  await executeDeepLink(
    { toggle_microphone: null },
    "Microphone toggled",
    "Failed to toggle microphone"
  );
}
