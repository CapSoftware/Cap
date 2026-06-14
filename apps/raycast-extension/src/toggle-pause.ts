import { closeMainWindow } from "@raycast/api";
import { openDeeplink } from "./deeplink";

export default async function togglePause() {
  await openDeeplink("toggle_pause", "Toggled pause");
  await closeMainWindow();
}
