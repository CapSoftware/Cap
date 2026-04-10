import { sendCapCommand } from "./utils";

export default async function Command() {
  await sendCapCommand("start_recording", {
    capture_mode: { screen: "Built-in Retina Display" }, // Fallback default or need to handle better
    camera: null,
    mic_label: null,
    capture_system_audio: true,
    mode: "Screen"
  });
}
