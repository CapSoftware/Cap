import { showToast, Toast } from "@raycast/api";
import * as deeplink from "./utils/deeplink";

export default async function Command() {
    try {
        await deeplink.pauseRecording();
        await showToast({
            style: Toast.Style.Success,
            title: "Recording Paused",
            message: "Cap recording has been paused",
        });
    } catch (error) {
        await showToast({
            style: Toast.Style.Failure,
            title: "Failed to Pause Recording",
            message: error instanceof Error ? error.message : "Unknown error occurred",
        });
    }
}
