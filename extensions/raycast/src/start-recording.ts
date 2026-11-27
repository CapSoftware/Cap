import {
	closeMainWindow,
	getPreferenceValues,
	type LaunchProps,
	open,
	showHUD,
	showToast,
	Toast,
} from "@raycast/api";
import type { ExtensionPreferences, StartRecordingArgs } from "./types";
import {
	buildStartRecordingPayload,
	buildStartRecordingUrl,
	readCapDesktopStore,
} from "./utils";

export default async function Command(
	props: LaunchProps<{ arguments: StartRecordingArgs }>,
) {
	const preferences = getPreferenceValues<ExtensionPreferences>();
	const args = props.arguments ?? {};

	try {
		await closeMainWindow();
		const store = readCapDesktopStore();
		const payload = buildStartRecordingPayload(args, preferences, store);
		const primaryUrl = buildStartRecordingUrl(payload, "cap-desktop");
		try {
			await open(primaryUrl);
		} catch {
			await open(buildStartRecordingUrl(payload, "cap"));
		}
		const targetLabel =
			"screen" in payload.capture_mode
				? payload.capture_mode.screen
				: payload.capture_mode.window;
		const modeLabel = payload.mode === "studio" ? "Studio" : "Instant";
		await showHUD(`Starting Cap ${modeLabel} recording (${targetLabel})`);
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Make sure Cap Desktop is installed and running on your machine.";
		await showToast({
			style: Toast.Style.Failure,
			title: "Failed to start Cap recording",
			message,
		});
	}
}
