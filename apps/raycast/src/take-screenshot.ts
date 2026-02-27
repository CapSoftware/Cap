import { executeDeepLink } from "./utils";

export default async function command() {
  await executeDeepLink(
    {
      take_screenshot: {
        capture_mode: { screen: "Main Display" },
      },
    },
    "Taking screenshot...",
  );
}
