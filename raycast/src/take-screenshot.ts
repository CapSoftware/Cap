import { executeDeepLink } from "./utils";

export default async function TakeScreenshot() {
  await executeDeepLink(
    {
      take_screenshot: {
        capture_mode: { screen: "Main Display" },
      },
    },
    "Taking screenshot with Cap",
  );
}
