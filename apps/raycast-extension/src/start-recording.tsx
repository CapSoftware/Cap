import { sendCapCommand } from "./utils";

export default async function Command() {
  await sendCapCommand("start_default_recording", "Recording Started");
}
