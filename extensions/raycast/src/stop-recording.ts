import { closeMainWindow, open, showHUD, showToast, Toast } from "@raycast/api";
import { buildStopRecordingUrl } from "./utils";

export default async function Command() {
	try {
		await closeMainWindow();
		try {
			await open(buildStopRecordingUrl("cap-desktop"));
		} catch {
			await open(buildStopRecordingUrl("cap"));
		}
		await showHUD(
			"Stopping Cap recording (share link copies to clipboard when ready)",
		);
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Make sure Cap Desktop is installed and running on your machine.";
		await showToast({
			style: Toast.Style.Failure,
			title: "Failed to stop Cap recording",
			message,
		});
	}
}
