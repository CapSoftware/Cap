import { showHUD, open } from "@raycast/api";

export default async function Command() {
  await open("cap-desktop://action?value=%22pause_recording%22");
  await showHUD("Cap: Recording paused");
}
