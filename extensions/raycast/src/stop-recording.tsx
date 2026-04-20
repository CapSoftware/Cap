import { open, showHUD } from "@raycast/api";

export default async function Command() {
  try {
    await open("cap://stop-recording");
    await showHUD("Stopping recording...");
  } catch {
    await showHUD("Failed to open Cap");
  }
}
