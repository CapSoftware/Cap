import { runDeepLinkAction } from "./lib/deeplink";

export default async function Command() {
  await runDeepLinkAction("resume_recording", "Cap resume requested");
}
