import { showToast, Toast } from "@raycast/api";
import { openDeeplink } from "./utils";

export default async function Command() {
	try {
		const toast = await showToast({
			style: Toast.Style.Animated,
			title: "Stopping recording...",
		});

		await openDeeplink("stop_recording", null);

		toast.style = Toast.Style.Success;
		toast.title = "Recording stopped";
	} catch {
		await showToast({
			style: Toast.Style.Failure,
			title: "Failed to stop recording",
		});
	}
}
