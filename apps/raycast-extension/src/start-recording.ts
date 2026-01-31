import { open } from "@raycast/api";

export default async function Command() {
  const action = {
    start_recording: {
      capture_mode: { screen: "Main Display" },
      camera: null,
      mic_label: null,
      capture_system_audio: false,
      mode: "studio",
    },
  };

  const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
  await open(url);
}
