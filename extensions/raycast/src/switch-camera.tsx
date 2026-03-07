import { open, showHUD } from "@raycast/api";

export default async function Command() {
  try {
    const action = { switch_camera: null };
    const deeplink = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;

    await open(deeplink);
    await showHUD("📷 Camera switched");
  } catch (error) {
    console.error("Failed to switch camera:", error);
    await showHUD("❌ Failed to switch camera");
  }
}
