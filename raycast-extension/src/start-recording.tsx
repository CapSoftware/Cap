import { showHUD, open } from "@raycast/api";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export default async function Command() {
  try {
    // Get the primary display name
    const { stdout } = await execAsync(
      `system_profiler SPDisplaysDataType | grep -A 1 "Display Type" | grep -v "Display Type" | head -1 | awk '{print $1}'`
    );
    const displayName = stdout.trim() || "Built-in Display";

    // Create deeplink URL for starting recording
    const action = {
      capture_mode: { screen: displayName },
      camera: null,
      mic_label: null,
      capture_system_audio: true,
      mode: "desktop",
    };

    const encodedAction = encodeURIComponent(JSON.stringify(action));
    const deeplinkUrl = `cap://action?value=${encodedAction}`;

    await open(deeplinkUrl);
    await showHUD("✅ Started recording");
  } catch (error) {
    console.error("Failed to start recording:", error);
    await showHUD("❌ Failed to start recording");
  }
}
