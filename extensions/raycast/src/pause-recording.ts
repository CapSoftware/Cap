import { runDeepLinkAction } from "./lib/deeplink";

export default async function Command() {
  await runDeepLinkAction("pause_recording", "Cap pause requested");
}
