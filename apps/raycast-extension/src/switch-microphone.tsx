import { sendCapCommand } from "./utils";

export default async function Command() {
    await sendCapCommand("cycle_microphone", "Switching Microphone...");
}
