import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

const CAMERA_WINDOW_PREFIX = "camera-";

const cameraWindowRank = (label: string) => {
	if (label === "camera") return 0;
	if (!label.startsWith(CAMERA_WINDOW_PREFIX)) return -1;
	const rank = Number(label.slice(CAMERA_WINDOW_PREFIX.length));
	return Number.isInteger(rank) && rank > 0 ? rank : -1;
};

export const isCameraWindowLabel = (label: string) =>
	cameraWindowRank(label) >= 0;

export const getCameraWindow = async () => {
	const windows = await WebviewWindow.getAll();
	return (
		windows
			.filter((window) => isCameraWindowLabel(window.label))
			.sort(
				(a, b) => cameraWindowRank(b.label) - cameraWindowRank(a.label),
			)[0] ?? null
	);
};
