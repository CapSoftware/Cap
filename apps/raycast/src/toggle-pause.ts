import { showHUD } from "@raycast/api";
import { executeDeepLink } from "./utils";

export default async function TogglePause() {
  await executeDeepLink("record/toggle-pause");
  await showHUD("⏯️ Recording pause toggled");
}
