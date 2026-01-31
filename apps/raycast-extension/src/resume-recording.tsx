import { sendCapCommand } from "./utils";

export default async function Command() {
    await sendCapCommand("resume_recording", "Recording Resumed");
}
