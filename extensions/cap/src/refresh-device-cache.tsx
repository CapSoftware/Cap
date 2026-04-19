import { closeMainWindow, showHUD } from "@raycast/api";
import { runCapDeeplink } from "./deeplink";

export default async function main() {
  await runCapDeeplink({ refresh_raycast_device_cache: null });
  await showHUD("Cap: device cache refresh sent");
  await closeMainWindow();
}
