import { fireSimpleAction } from "./lib/cap";

export default async function Command() {
  await fireSimpleAction("toggle_pause_recording");
}
