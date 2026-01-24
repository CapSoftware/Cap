import { sendCapCommand } from "./utils";

export default async function Command() {
    await sendCapCommand("pause_recording", "Recording Paused");
}
