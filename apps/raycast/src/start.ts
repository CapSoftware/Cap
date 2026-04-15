import { sendCapCommand } from "./utils";

export default async function Command() {
  await sendCapCommand("start_recording", {
    capture_mode: "primary_screen",
    camera: null,
    mic_label: null,
    capture_system_audio: true,
    mode: "Screen"
  });
}
