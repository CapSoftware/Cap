import { showToast, Toast } from "@raycast/api";
import * as deeplink from "./utils/deeplink";

export default async function Command() {
    try {
        await deeplink.stopRecording();
        await showToast({
            style: Toast.Style.Success,
            title: "Recording Stopped",
            message: "Cap recording has been stopped",
        });
    } catch (error) {
        await showToast({
            style: Toast.Style.Failure,
            title: "Failed to Stop Recording",
            message: error instanceof Error ? error.message : "Unknown error occurred",
        });
    }
}
