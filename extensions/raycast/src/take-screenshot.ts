import { triggerDeepLink } from "./utils";

export default async function Command() {
  await triggerDeepLink(
    {
      take_screenshot: {
        capture_mode: { screen: "Main Display" },
      },
    },
    "📸 Taking screenshot with Cap…",
  );
}
