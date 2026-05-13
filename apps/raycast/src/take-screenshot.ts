import { closeMainWindow, showHUD } from "@raycast/api";

import { sendAction } from "./utils";

export default async function Command() {
  await closeMainWindow();
  await sendAction("take_screenshot");
  await showHUD("Cap: Screenshot taken");
}
