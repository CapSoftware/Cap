import {
	type StopRecordingPreferences,
	buildStopRecordingDeepLink,
	extractShareableCapUrl,
} from "./deeplink";
import {
	Clipboard,
	closeMainWindow,
	getPreferenceValues,
	open,
	showHUD,
} from "./raycast-bridge";

const STOP_CLIPBOARD_POLL_ATTEMPTS = 6;
const STOP_CLIPBOARD_POLL_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForNewShareUrl(
	previousClipboard: string | undefined,
	dashboardUrl: string | undefined,
): Promise<string | null> {
	for (let attempt = 0; attempt < STOP_CLIPBOARD_POLL_ATTEMPTS; attempt++) {
		await sleep(STOP_CLIPBOARD_POLL_DELAY_MS);
		const currentText = await Clipboard.readText();
		if (!currentText || currentText === previousClipboard) {
			continue;
		}
		const shareUrl = extractShareableCapUrl(currentText, dashboardUrl);
		if (shareUrl) {
			return shareUrl;
		}
	}
	return null;
}

export default async function Command(): Promise<void> {
	const prefs = await getPreferenceValues<StopRecordingPreferences>();
	const previousClipboard = await Clipboard.readText();
	const deepLinkUrl = buildStopRecordingDeepLink();

	await closeMainWindow();
	await open(deepLinkUrl);

	if (prefs.copyUrlOnStop ?? true) {
		const shareUrl = await waitForNewShareUrl(
			previousClipboard,
			prefs.dashboardUrl,
		);
		if (shareUrl) {
			await Clipboard.copy(shareUrl);
			await showHUD(`Cap recording stopped — copied ${shareUrl}`);
			return;
		}
	}

	await showHUD("Cap recording stopped");
}
