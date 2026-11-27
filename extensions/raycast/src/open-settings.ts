import { closeMainWindow, open, showHUD, showToast, Toast } from "@raycast/api";
import { buildOpenSettingsUrl } from "./utils";

export default async function Command() {
	try {
		await closeMainWindow();
		try {
			await open(buildOpenSettingsUrl(null, "cap-desktop"));
		} catch {
			await open(buildOpenSettingsUrl(null, "cap"));
		}
		await showHUD("Opened Cap Settings");
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Make sure Cap Desktop is installed on your machine.";
		await showToast({
			style: Toast.Style.Failure,
			title: "Failed to open Cap Settings",
			message,
		});
	}
}
