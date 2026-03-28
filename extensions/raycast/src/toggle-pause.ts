import { showHUD } from "@raycast/api";
import { sendDeepLink } from "./utils";

export default async function Command() {
  await sendDeepLink({ toggle_pause_recording: {} });
  await showHUD("Recording pause toggled");
}
