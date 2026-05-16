import { open, showToast, Toast } from "@raycast/api";

type RecordingMode = "studio" | "instant" | "screenshot";
type RecordingTargetMode = "display" | "window" | "area" | "camera";
type DeviceOrModelID =
	| {
			device_id: string;
	  }
	| {
			model_id: string;
	  };

type DeepLinkAction =
	| {
			start_recording_with_settings: {
				mode: RecordingMode;
			};
	  }
	| "stop_recording"
	| "pause_recording"
	| "resume_recording"
	| "toggle_pause_recording"
	| {
			open_recording_picker: {
				target_mode: RecordingTargetMode | null;
			};
	  }
	| {
			set_mic_input: {
				label: string | null;
			};
	  }
	| {
			set_camera_input: {
				id: DeviceOrModelID | null;
			};
	  };

export async function runCapAction(action: DeepLinkAction, title: string) {
	const url = new URL("cap://action");
	url.searchParams.set("value", JSON.stringify(action));

	await open(url.toString());
	await showToast({
		style: Toast.Style.Success,
		title,
	});
}

export function deviceId(value: string): DeviceOrModelID {
	return { device_id: value };
}

export function modelId(value: string): DeviceOrModelID {
	return { model_id: value };
}
