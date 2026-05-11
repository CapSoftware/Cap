import { showToast, Toast } from "@raycast/api";
import { openDeeplink } from "./utils";

export default async function Command() {
	try {
		const toast = await showToast({
			style: Toast.Style.Animated,
			title: "Toggling pause...",
		});

		await openDeeplink("toggle_pause_recording", null);

		toast.style = Toast.Style.Success;
		toast.title = "Pause toggled";
	} catch {
		await showToast({
			style: Toast.Style.Failure,
			title: "Failed to toggle pause",
		});
	}
}
