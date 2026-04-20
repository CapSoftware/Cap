import { open, showHUD } from "@raycast/api";

export default async function Command() {
  try {
    await open("cap://mute-recording");
    await showHUD("Muting microphone...");
  } catch {
    await showHUD("Failed to open Cap");
  }
}
