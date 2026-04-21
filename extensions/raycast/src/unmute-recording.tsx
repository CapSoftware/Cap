import { open, showHUD } from "@raycast/api";

export default async function Command() {
  try {
    await open("cap://unmute-recording");
    await showHUD("Unmuting microphone...");
  } catch {
    await showHUD("Failed to open Cap");
  }
}
