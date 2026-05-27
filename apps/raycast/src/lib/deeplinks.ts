import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { open, showHUD, showToast, Toast } from "@raycast/api";

export type CapControlAction = {
	key: string;
	title: string;
	subtitle: string;
	url: string;
	successTitle: string;
	icon: "record" | "stop" | "pause" | "resume" | "toggle";
};

export const capControlActions: CapControlAction[] = [
	{
		key: "start-studio",
		title: "Start Studio Recording",
		subtitle: "Uses cap-desktop://record/start?mode=studio",
		url: "cap-desktop://record/start?mode=studio",
		successTitle: "Sent studio start to Cap",
		icon: "record",
	},
	{
		key: "start-instant",
		title: "Start Instant Recording",
		subtitle: "Uses cap-desktop://record/start?mode=instant",
		url: "cap-desktop://record/start?mode=instant",
		successTitle: "Sent instant start to Cap",
		icon: "record",
	},
	{
		key: "stop",
		title: "Stop Recording",
		subtitle: "Uses cap-desktop://record/stop",
		url: "cap-desktop://record/stop",
		successTitle: "Sent stop to Cap",
		icon: "stop",
	},
	{
		key: "pause",
		title: "Pause Recording",
		subtitle: "Uses cap-desktop://record/pause",
		url: "cap-desktop://record/pause",
		successTitle: "Sent pause to Cap",
		icon: "pause",
	},
	{
		key: "resume",
		title: "Resume Recording",
		subtitle: "Uses cap-desktop://record/resume",
		url: "cap-desktop://record/resume",
		successTitle: "Sent resume to Cap",
		icon: "resume",
	},
	{
		key: "toggle-pause",
		title: "Toggle Pause",
		subtitle: "Uses cap-desktop://record/toggle-pause",
		url: "cap-desktop://record/toggle-pause",
		successTitle: "Sent toggle pause to Cap",
		icon: "toggle",
	},
];

const RAYCAST_DEEPLINK_TOKEN_FILE = "raycast-deeplink-token";

function requiresToken(url: string): boolean {
	return (
		url.startsWith("cap-desktop://record/") ||
		url.startsWith("cap-desktop://device/")
	);
}

async function readCapDeeplinkToken(): Promise<string> {
	const tokenPath = join(
		homedir(),
		"Library",
		"Application Support",
		"so.cap.desktop",
		RAYCAST_DEEPLINK_TOKEN_FILE,
	);
	const token = (await readFile(tokenPath, "utf8")).trim();
	if (!token) {
		throw new Error(
			"Cap deeplink token is empty. Open Cap once and try again.",
		);
	}
	return token;
}

async function authorizeCapDeeplink(url: string): Promise<string> {
	if (!requiresToken(url)) return url;

	const token = await readCapDeeplinkToken();
	const parsed = new URL(url);
	parsed.searchParams.set("token", token);
	return parsed.toString();
}

export async function openCapDeeplink(
	url: string,
	successTitle: string,
): Promise<void> {
	try {
		await open(await authorizeCapDeeplink(url));
		await showHUD(successTitle);
	} catch (error) {
		await showToast({
			style: Toast.Style.Failure,
			title: "Failed to open Cap deeplink",
			message: error instanceof Error ? error.message : String(error),
		});
	}
}
