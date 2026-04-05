import { triggerDeepLink } from "./utils";

export default async function Command() {
  await triggerDeepLink(
    {
      take_screenshot: {
        capture_mode: null,
      },
    },
    "📸 Taking screenshot with Cap…",
  );
}
