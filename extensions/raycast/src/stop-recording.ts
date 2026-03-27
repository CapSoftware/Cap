import { showHUD } from "@raycast/api";
import { sendDeepLink } from "./utils";

export default async function Command() {
  await sendDeepLink({ stop_recording: {} });
  await showHUD("Recording stopped");
}
