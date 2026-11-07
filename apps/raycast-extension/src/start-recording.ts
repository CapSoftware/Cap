import {
	type StartRecordingPreferences,
	buildStartRecordingDeepLink,
} from "./deeplink";
import {
	Clipboard,
	closeMainWindow,
	getPreferenceValues,
	open,
	showHUD,
} from "./raycast-bridge";

export default async function Command(): Promise<void> {
	const prefs = await getPreferenceValues<StartRecordingPreferences>();
	try {
		const deepLinkUrl = buildStartRecordingDeepLink(prefs);
		await closeMainWindow();
		await open(deepLinkUrl);
		await showHUD(
			`Cap recording started (${prefs.defaultMode || "instant"} mode)`,
		);
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to resolve target screen name";
		await showHUD(message);
	}
}

export { Clipboard };
