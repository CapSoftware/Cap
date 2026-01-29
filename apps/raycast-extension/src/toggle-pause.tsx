import { showToast, Toast } from "@raycast/api";
import * as deeplink from "./utils/deeplink";

export default async function Command() {
    try {
        await deeplink.togglePauseRecording();
        await showToast({
            style: Toast.Style.Success,
            title: "Recording Toggled",
            message: "Cap recording pause state toggled",
        });
    } catch (error) {
        await showToast({
            style: Toast.Style.Failure,
            title: "Failed to Toggle Pause",
            message: error instanceof Error ? error.message : "Unknown error occurred",
        });
    }
}
