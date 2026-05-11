import { showToast, Toast } from "@raycast/api";
import { openDeeplink } from "./utils";

export default async function Command() {
	const toast = await showToast({
		style: Toast.Style.Animated,
		title: "Opening settings...",
	});

	await openDeeplink("open_settings", { page: null });

	toast.style = Toast.Style.Success;
	toast.title = "Settings opened";
}
