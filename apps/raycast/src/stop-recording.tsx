import { open, showHUD } from "@raycast/api";
import { buildDeeplinkUrl } from "./utils";

export default async function Command() {
  await open(buildDeeplinkUrl("stop_recording"));
  await showHUD("Stopping Cap recording");
}
