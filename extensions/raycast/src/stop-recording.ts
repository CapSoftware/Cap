import { triggerDeepLink } from "./utils";

export default async function Command() {
  await triggerDeepLink("stop_recording", "⏹ Stopping Cap recording…");
}
