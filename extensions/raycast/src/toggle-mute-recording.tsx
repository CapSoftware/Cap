import { open, showHUD } from "@raycast/api";

export default async function Command() {
  try {
    await open("cap://toggle-mute-recording");
    await showHUD("Toggling mute...");
  } catch {
    await showHUD("Failed to open Cap");
  }
}
