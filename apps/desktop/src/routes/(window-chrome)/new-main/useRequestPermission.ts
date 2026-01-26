import { useQueryClient } from "@tanstack/solid-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getPermissions } from "~/utils/queries";
import { commands } from "~/utils/tauri";

export default function useRequestPermission() {
	const queryClient = useQueryClient();

	async function requestPermission(type: "camera" | "microphone") {
		const currentWindow = getCurrentWindow();
		try {
			const permissions = await commands.doPermissionsCheck(false);
			const currentStatus =
				type === "camera" ? permissions.camera : permissions.microphone;

			if (currentStatus === "denied") {
				if (type === "camera") {
					await commands.resetCameraPermissions();
				} else if (type === "microphone") {
					await commands.resetMicrophonePermissions();
				}
			}

			await currentWindow.hide();
			await commands.requestPermission(type);
			await queryClient.refetchQueries(getPermissions);
		} catch (error) {
			console.error(`Failed to get ${type} permission:`, error);
		} finally {
			await currentWindow.show();
		}
	}

	return requestPermission;
}
