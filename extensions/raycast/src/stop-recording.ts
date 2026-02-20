import { runDeepLinkAction } from "./lib/deeplink";

export default async function Command() {
  await runDeepLinkAction("stop_recording", "Cap stop requested");
}
