import { open, showHUD } from "@raycast/api";

export default async function Command() {
  await open("cap://restart-recording");
  await showHUD("🔄 Restarting Cap recording…");
}
