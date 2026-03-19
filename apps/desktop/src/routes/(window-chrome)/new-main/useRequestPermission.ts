import { useQueryClient } from "@tanstack/solid-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
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

			const window = getCurrentWindow();
			await window.setAlwaysOnTop(false);
			try {
				await commands.requestPermission(type);

				const check = await commands.doPermissionsCheck(false);
				const status = type === "camera" ? check.camera : check.microphone;

				if (status !== "granted") {
					await commands.openPermissionSettings(type);
				}
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
