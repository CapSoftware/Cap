import { open, showHUD } from "@raycast/api";

export default async function Command() {
  try {
    await open("cap://take-screenshot");
    await showHUD("Taking screenshot...");
  } catch {
    await showHUD("Failed to open Cap");
  }
}
