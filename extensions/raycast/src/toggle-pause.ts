import { triggerDeepLink } from "./utils";

export default async function Command() {
  await triggerDeepLink("toggle_pause_recording", "⏯ Toggling Cap recording pause…");
}
