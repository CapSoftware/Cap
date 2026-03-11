import { open, showHUD } from "@raycast/api";

export default async function Command() {
  await open("cap://stop-recording");
  await showHUD("⏹ Stopping Cap recording…");
}
