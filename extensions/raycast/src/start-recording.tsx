import { open, showHUD } from "@raycast/api";

export default async function Command() {
  try {
    await open("cap://start-recording");
    await showHUD("Starting recording...");
  } catch {
    await showHUD("Failed to open Cap");
  }
}
