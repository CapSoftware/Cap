import { showToast, Toast } from "@raycast/api";
import * as deeplink from "./utils/deeplink";

export default async function Command() {
    try {
        await deeplink.resumeRecording();
        await showToast({
            style: Toast.Style.Success,
            title: "Recording Resumed",
            message: "Cap recording has been resumed",
        });
    } catch (error) {
        await showToast({
            style: Toast.Style.Failure,
            title: "Failed to Resume Recording",
            message: error instanceof Error ? error.message : "Unknown error occurred",
        });
    }
}
