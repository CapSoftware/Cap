import { useQueryClient } from "@tanstack/solid-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { devicesSnapshot } from "~/utils/devices";
import { requestAndVerifyPermission } from "~/utils/os-permissions";
import { commands, type OSPermissionStatus } from "~/utils/tauri";

export default function useRequestPermission() {
	const queryClient = useQueryClient();

	async function requestPermission(
		type: "camera" | "microphone",
		currentStatus?: OSPermissionStatus,
	) {
		try {
			const window = getCurrentWindow();
			await window.setAlwaysOnTop(false);
			try {
				await requestAndVerifyPermission(commands, type, currentStatus);
			} finally {
				await window.setAlwaysOnTop(true);
			}
			await queryClient.refetchQueries(devicesSnapshot);
		} catch (error) {
			console.error(`Failed to get ${type} permission:`, error);
		}
	}

	return requestPermission;
}
