import { triggerDeepLink } from "./utils";

export default async function Command() {
  await triggerDeepLink("restart_recording", "🔄 Restarting Cap recording…");
}
