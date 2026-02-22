import { closeMainWindow, open, showHUD } from "@raycast/api";

export default async function Command() {
  await closeMainWindow();
  await open("cap://pause-recording");
  await showHUD("Pausing recording…");
}