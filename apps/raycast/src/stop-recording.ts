import { closeMainWindow, showHUD } from "@raycast/api";

import { sendAction } from "./utils";

export default async function Command() {
  await closeMainWindow();
  await sendAction("stop_recording");
  await showHUD("Cap: Recording stopped");
}
