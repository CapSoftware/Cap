import { triggerAction } from "./utils";
import { showHUD } from "@raycast/api";

export default async function Command() {
  await triggerAction("resume_recording");
  await showHUD("Resuming Cap Recording");
}
