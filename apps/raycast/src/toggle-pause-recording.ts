import { closeMainWindow, showHUD } from "@raycast/api";

import { sendAction } from "./utils";

export default async function Command() {
  await closeMainWindow();
  await sendAction("toggle_pause_recording");
  await showHUD("Cap: Recording toggle paused/resumed");
}
