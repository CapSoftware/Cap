import { showHUD, open } from "@raycast/api";

export default async function Command() {
  try {
    const action = {
      open_settings: {
        page: null,
      },
    };

    const encodedAction = encodeURIComponent(JSON.stringify(action));
    const deeplinkUrl = `cap://action?value=${encodedAction}`;

    await open(deeplinkUrl);
    await showHUD("⚙️ Opened Cap settings");
  } catch (error) {
    console.error("Failed to open settings:", error);
    await showHUD("❌ Failed to open settings");
  }
}
