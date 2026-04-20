import { open, showHUD } from "@raycast/api";

export default async function Command() {
  try {
    await open("cap://toggle-pause-recording");
    await showHUD("Toggling pause...");
  } catch {
    await showHUD("Failed to open Cap");
  }
}
