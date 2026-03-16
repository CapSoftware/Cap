import { open, showHUD } from "@raycast/api";
import { buildDeeplinkUrl } from "./utils";

export default async function Command() {
  await open(buildDeeplinkUrl("resume_recording"));
  await showHUD("Resuming Cap recording");
}
