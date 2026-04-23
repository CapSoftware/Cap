import { showHUD } from "@raycast/api";
import { triggerDeeplink } from "./lib/deeplink";

export default async function Command() {
  await triggerDeeplink({ GetStatus: {} });
  await showHUD("📡 Status request sent to Cap");
}
