import { open, closeMainWindow } from "@raycast/api";

export default async function Command() {
    const payload = {
        action: "cycle_camera"
    };
    await open(`cap://action?value=${encodeURIComponent(JSON.stringify(payload))}`);
    await closeMainWindow();
}
