import type { OpenDialogOptions } from "@tauri-apps/plugin-dialog";
import type { OsType } from "@tauri-apps/plugin-os";

export const getExistingRecordingPickerOptions = (
	platform: OsType,
	defaultPath: string,
): OpenDialogOptions => {
	if (platform === "windows") {
		return {
			defaultPath,
			directory: true,
			multiple: false,
		};
	}

	return {
		defaultPath,
		filters: [{ name: "Cap Recording", extensions: ["cap"] }],
		multiple: false,
	};
};
