import { showToast, Toast } from "@raycast/api";
import { openDeeplink } from "./utils";

export default async function Command() {
	const toast = await showToast({
		style: Toast.Style.Animated,
		title: "Stopping recording...",
	});

	await openDeeplink("stop_recording", null);

	toast.style = Toast.Style.Success;
	toast.title = "Recording stopped";
}
