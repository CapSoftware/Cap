import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export async function hideCameraWindow() {
	const cameraWindow = await WebviewWindow.getByLabel("camera");
	if (!cameraWindow) return;

	try {
		await cameraWindow.hide();
	} catch (error) {
		console.error("Failed to hide camera window", error);
	}
}
