import { executeDeepLink, getDisplayName } from "./utils";

export default async function command() {
  await executeDeepLink(
    {
      take_screenshot: {
        capture_mode: { screen: getDisplayName() },
      },
    },
    "Taking screenshot...",
  );
}
