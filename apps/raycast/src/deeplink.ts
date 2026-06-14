import { closeMainWindow, open, showHUD, showToast, Toast } from "@raycast/api";

type ActionPayload =
	| "stop_recording"
	| "pause_recording"
	| "resume_recording"
	| {
			switch_camera: {
				camera: { ModelID: string } | { DeviceID: string } | null;
			};
	  }
	| { switch_microphone: { mic_label: string | null } };

export function buildActionUrl(payload: ActionPayload): string {
	const value = JSON.stringify(payload);
	const url = new URL("cap-desktop://action");
	url.searchParams.set("value", value);
	return url.toString();
}

export async function fireAction(
	payload: ActionPayload,
	successMessage: string,
): Promise<void> {
	try {
		await open(buildActionUrl(payload));
		await closeMainWindow();
		await showHUD(successMessage);
	} catch (error) {
		await showToast({
			style: Toast.Style.Failure,
			title: "Failed to reach Cap",
			message: error instanceof Error ? error.message : String(error),
		});
	}
}
