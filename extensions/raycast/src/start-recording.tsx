import { open, showHUD, getApplications } from "@raycast/api";

export default async function Command() {
  try {
    const apps = await getApplications();
    const capInstalled = apps.some(
      (app) =>
        app.bundleId === "so.cap.desktop" ||
        app.bundleId === "so.cap.desktop.dev",
    );

    if (!capInstalled) {
      await showHUD("❌ Cap is not installed");
      return;
    }

    const action = {
      start_recording: {},
    };

    const deeplink = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;

    await open(deeplink);
    await showHUD("🎥 Started recording");
  } catch (error) {
    console.error("Failed to start recording:", error);
    await showHUD("❌ Failed to start recording");
  }
}
