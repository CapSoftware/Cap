import { showToast, Toast } from "@raycast/api";
import { openDeeplink } from "./utils";

export default async function Command() {
	const toast = await showToast({
		style: Toast.Style.Animated,
		title: "Toggling pause...",
	});

	await openDeeplink("toggle_pause_recording", null);

	toast.style = Toast.Style.Success;
	toast.title = "Pause toggled";
}
