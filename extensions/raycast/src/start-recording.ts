import { runDeepLinkAction } from "./lib/deeplink";

export default async function Command() {
  await runDeepLinkAction("start_current_recording", "Cap start requested");
}
