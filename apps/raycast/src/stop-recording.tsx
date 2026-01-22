import { open, closeMainWindow } from "@raycast/api";

export default async function Command() {
    const payload = {
        action: "stop_recording"
    };
    await open(`cap://action?value=${encodeURIComponent(JSON.stringify(payload))}`);
    await closeMainWindow();
}
