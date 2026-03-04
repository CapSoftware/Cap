import { runDeepLinkAction } from "./lib/deeplink";

export default async function takeScreenshot() {
  await runDeepLinkAction(
    { take_screenshot: { capture_mode: null } },
    "Screenshot taken",
  );
}
