import { open, closeMainWindow } from "@raycast/api";

export default async function Command() {
    const payload = {
        action: "start_recording",
        mode: "instant",
        capture_mode: "primary"
    };
    await open(`cap://action?value=${encodeURIComponent(JSON.stringify(payload))}`);
    await closeMainWindow();
}
