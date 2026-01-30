import { open, showHUD } from "@raycast/api";

export default async function Command() {
  try {
    await open("cap://stop");
    await showHUD("Stopping Cap recording...");
  } catch (error) {
    await showHUD("Failed to open Cap");
  }
}
