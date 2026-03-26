import { triggerDeepLink } from "./utils";

export default async function Command() {
  await triggerDeepLink("resume_recording", "▶️ Resuming Cap recording…");
}
