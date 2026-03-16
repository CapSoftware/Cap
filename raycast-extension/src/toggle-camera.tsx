import { showHUD, open } from "@raycast/api";

export default async function Command() {
  try {
    const action = "toggle_camera";
    const url = `cap-desktop://action?value="${action}"`;
    await open(url);
    await showHUD("📹 Toggling camera");
  } catch (error) {
    await showHUD("❌ Failed to toggle camera");
    console.error(error);
  }
}
