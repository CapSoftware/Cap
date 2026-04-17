import { showHUD } from "@raycast/api";
import { executeDeepLink } from "./utils";

export default async function OpenSettings() {
  await executeDeepLink("settings");
  await showHUD("⚙️ Opening Cap settings");
}
