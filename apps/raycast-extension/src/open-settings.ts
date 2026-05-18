import { closeMainWindow } from "@raycast/api";
import { openDeeplink } from "./deeplink";

export default async function openSettings() {
  await openDeeplink({ open_settings: { page: null } }, "Opening settings");
  await closeMainWindow();
}
