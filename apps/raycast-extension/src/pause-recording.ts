import { open, showHUD } from "@raycast/api";

export default async function Command() {
  await open("cap://pause-recording");
  await showHUD("⏸ Pausing Cap recording…");
}
