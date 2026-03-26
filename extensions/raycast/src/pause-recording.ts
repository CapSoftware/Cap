import { triggerDeepLink } from "./utils";

export default async function Command() {
  await triggerDeepLink("pause_recording", "⏸ Pausing Cap recording…");
}
