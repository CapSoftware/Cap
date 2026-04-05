import { showHUD, open } from "@raycast/api";

export default async function Command() {
  try {
    // Open the deeplink to start recording
    // Note: This requires pre-configuration with capture mode, camera, and mic settings
    // A full implementation would allow selecting these parameters
    const action = {
      start_recording: {
        capture_mode: { screen: "Primary" },
        camera: null,
        mic_label: null,
        capture_system_audio: false,
        mode: "studio"
      }
    };
    
    const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
    await open(url);
    await showHUD("✅ Starting Cap recording");
  } catch (error) {
    await showHUD("❌ Failed to start recording");
    console.error(error);
  }
}
