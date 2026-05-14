import { triggerAction } from "./utils";
import { showHUD } from "@raycast/api";

export default async function Command() {
  await triggerAction("pause_recording");
  await showHUD("Pausing Cap Recording");
}
