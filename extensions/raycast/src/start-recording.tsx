import { open, showHUD, getApplications } from "@raycast/api";

export default async function Command() {
  const apps = await getApplications();
  const capInstalled = apps.some(
    (app) => app.bundleId === "so.cap.desktop" || app.bundleId === "so.cap.desktop.dev"
  );

  if (!capInstalled) {
    await showHUD("❌ Cap is not installed");
    return;
  }

  // Start recording with default settings
  const action = {
    start_recording: {
      capture_mode: { screen: "Built-in Display" },
      camera: null,
      mic_label: null,
      capture_system_audio: false,
      mode: "studio"
    }
  };

  const deeplink = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
  
  try {
    await open(deeplink);
    await showHUD("🎬 Recording started");
  } catch (error) {
    await showHUD("❌ Failed to start recording");
  }
}
