import { closeMainWindow, open, showToast, Toast } from "@raycast/api";

type CapAction =
	| "stop_recording"
	| "restart_recording"
	| "pause_recording"
	| "resume_recording"
	| "toggle_pause_recording"
	| {
			start_recording_from_settings: {
				mode: "studio" | "instant";
			};
	  }
	| {
			open_recording_picker: {
				target_mode: "display" | "window" | "area" | null;
			};
	  }
	| {
			set_microphone: {
				mic_label: string | null;
			};
	  }
	| {
			set_camera: {
				camera: { DeviceID: string } | null;
			};
	  }
	| {
			open_settings: {
				page: string | null;
			};
	  };

export async function runCapAction(action: CapAction, title: string) {
	const value = encodeURIComponent(JSON.stringify(action));
	const url = `cap-desktop://action?value=${value}`;

	try {
		await open(url);
		await closeMainWindow();
		await showToast({ style: Toast.Style.Success, title });
	} catch (error) {
		await showToast({
			style: Toast.Style.Failure,
			title: "Could not open Cap",
			message: error instanceof Error ? error.message : String(error),
		});
	}
}
