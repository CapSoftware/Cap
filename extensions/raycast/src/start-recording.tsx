import { open } from "@raycast/api";

export default async function Command() {
  const value = JSON.stringify({
    StartRecording: {
      capture_mode: { Screen: "" },
      camera: null,
      mic_label: null,
      capture_system_audio: false,
      mode: "Studio",
    },
  });
  await open(`cap://action?value=${encodeURIComponent(value)}`);
}
