import { open, showHUD } from "@raycast/api";
import { buildDeeplinkUrl } from "./utils";

export default async function Command() {
  await open(buildDeeplinkUrl("toggle_pause_recording"));
  await showHUD("Toggling Cap recording pause");
}
