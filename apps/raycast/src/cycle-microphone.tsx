import { open, closeMainWindow } from "@raycast/api";

export default async function Command() {
    const payload = {
        action: "cycle_microphone"
    };
    await open(`cap://action?value=${encodeURIComponent(JSON.stringify(payload))}`);
    await closeMainWindow();
}
