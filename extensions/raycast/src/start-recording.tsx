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

  const action = {
    open_settings: { page: "recording" }
  };

  const deeplink = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
  
  try {
    await open(deeplink);
    await showHUD("📺 Opening Cap recording settings...");
  } catch (error) {
    await showHUD("❌ Failed to open Cap");
  }
}
