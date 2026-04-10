import { execFile } from "node:child_process";
import { closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";

function openUrl(url: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile("open", [url], (error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

export function buildCapUrl(
	path: string,
	params?: Record<string, string | undefined>,
) {
	const normalizedPath = path.replace(/^\/+/, "");
	const url = new URL(`cap-desktop://${normalizedPath}`);

	if (params) {
		for (const [key, value] of Object.entries(params)) {
			const normalizedValue = value?.trim();
			if (normalizedValue) {
				url.searchParams.set(key, normalizedValue);
			}
		}
	}

	return url.toString();
}

export async function sendCapDeepLink(
	path: string,
	params?: Record<string, string | undefined>,
) {
	const url = buildCapUrl(path, params);

	try {
		await openUrl(url);
		await closeMainWindow();
		await showHUD("Sent to Cap");
	} catch (error) {
		await showToast({
			style: Toast.Style.Failure,
			title: "Failed to open Cap deeplink",
			message: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
