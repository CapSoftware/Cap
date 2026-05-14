import { triggerAction } from "./utils";
import { showHUD } from "@raycast/api";

export default async function Command() {
  await triggerAction("stop_recording");
  await showHUD("Stopping Cap Recording");
}
