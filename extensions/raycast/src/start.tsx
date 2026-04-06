import { executeJsonAction } from "./utils";

export default async function Command() {
  await executeJsonAction("start_recording", {
    capture_mode: { screen: "primary" },
    mode: "normal",
    capture_system_audio: false,
  });
}
