import { sendCapCommand } from "./utils";

export default async function Command() {
    await sendCapCommand("stop_recording", "Recording Stopped");
}
