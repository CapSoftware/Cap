import { open, showHUD } from "@raycast/api";
import { buildDeeplinkUrl } from "./utils";

export default async function Command() {
  await open(buildDeeplinkUrl("pause_recording"));
  await showHUD("Pausing Cap recording");
}
