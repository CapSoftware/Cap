import { closeMainWindow, open, showHUD } from "@raycast/api";

export default async function Command() {
  await closeMainWindow();

  const dashboardUrl = "https://cap.so/dashboard";
  try {
    await open(dashboardUrl);
    await showHUD("🌐 Opening Cap Dashboard...");
  } catch (error) {
    await showHUD("⚠️ Failed to open Cap Dashboard.");
  }
}
