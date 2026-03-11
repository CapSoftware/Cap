import { open, showHUD } from "@raycast/api";

export default async function Command() {
  await open("cap://start-recording");
  await showHUD("▶ Starting Cap recording…");
}
