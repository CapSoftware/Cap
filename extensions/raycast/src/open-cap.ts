import { showHUD } from "@raycast/api";
import { openCap } from "./utils";

export default async function command() {
  try {
    await openCap();
    await showHUD("🎬 Opening Cap...");
  } catch {
    await showHUD("❌ Failed to open Cap. Is it installed?");
  }
}
