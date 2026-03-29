import { showHUD } from "@raycast/api";
import { sendDeepLink } from "./utils";

export default async function command() {
  try {
    // serde struct variant with optional field
    await sendDeepLink({ open_settings: { page: null } });
    await showHUD("⚙️ Cap: Opening settings...");
  } catch {
    await showHUD("❌ Failed to open settings. Is Cap running?");
  }
}
