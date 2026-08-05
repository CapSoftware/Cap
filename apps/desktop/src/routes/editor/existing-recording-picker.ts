import type { OpenDialogOptions } from "@tauri-apps/plugin-dialog";
import type { OsType } from "@tauri-apps/plugin-os";

export const getExistingRecordingPickerOptions = (
	platform: OsType,
	defaultPath: string,
): OpenDialogOptions => {
	if (platform === "windows") {
		return {
			title: "Select Cap Recording Directory (.cap)",
			defaultPath,
			directory: true,
			multiple: false,
		};
	}

	return {
		title: "Select Cap Recording",
		defaultPath,
		filters: [{ name: "Cap Recording", extensions: ["cap"] }],
		multiple: false,
	};
};
