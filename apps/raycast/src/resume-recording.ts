import { closeMainWindow, showHUD } from "@raycast/api";

import { sendAction } from "./utils";

export default async function Command() {
  await closeMainWindow();
  await sendAction("resume_recording");
  await showHUD("Cap: Recording resumed");
}
