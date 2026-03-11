import { open, showHUD } from "@raycast/api";

export default async function Command() {
  await open("cap://resume-recording");
  await showHUD("▶ Resuming Cap recording…");
}
