import { useQueryClient } from "@tanstack/solid-query";
import { devicesSnapshot } from "~/utils/devices";
import { commands, type OSPermissionStatus } from "~/utils/tauri";

export default function useRequestPermission() {
	const queryClient = useQueryClient();

	async function requestPermission(
		type: "camera" | "microphone",
		currentStatus?: OSPermissionStatus,
	) {
		try {
			if (currentStatus === "denied") {
				await commands.openPermissionSettings(type);
				return;
			}

			if (type === "camera") {
				await commands.resetCameraPermissions();
			} else if (type === "microphone") {
				await commands.resetMicrophonePermissions();
			}
			await commands.requestPermission(type);
			await queryClient.refetchQueries(devicesSnapshot);
		} catch (error) {
			console.error(`Failed to get ${type} permission:`, error);
		}
	}

	return requestPermission;
}
