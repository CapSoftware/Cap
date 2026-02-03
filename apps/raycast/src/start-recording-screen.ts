import { openCapDeepLink } from "./utils";

export default async function Command() {
  await openCapDeepLink({
    start_recording: {
      capture_mode: { screen: "Built-in Display" },
      camera: null,
      mic_label: null,
      capture_system_audio: true,
      mode: "instant",
    },
  });
}
