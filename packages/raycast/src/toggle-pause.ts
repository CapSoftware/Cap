import { triggerAction } from "./utils";
import { showHUD } from "@raycast/api";

export default async function Command() {
  await triggerAction("toggle_pause_recording");
  await showHUD("Toggling Cap Pause");
}
