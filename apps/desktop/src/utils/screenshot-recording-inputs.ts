import type { DeviceOrModelID, RecordingMode } from "~/utils/tauri";

type SetCameraInput = (args: {
	model: DeviceOrModelID | null;
	skipCameraWindow?: boolean;
}) => Promise<unknown>;

type RecordingInputHandlers = {
	restoreRecordingInputs: (
		micName: string | null,
		cameraID: DeviceOrModelID | null,
	) => Promise<void>;
	suspendRecordingInputsForScreenshot: () => Promise<void>;
	syncRecordingInputsForMode: (args: {
		mode: RecordingMode;
		micName: string | null;
		cameraID: DeviceOrModelID | null;
	}) => Promise<void>;
};

type SkipCameraWindow = boolean | (() => boolean);

export function createRecordingInputHandlers({
	setMicInput,
	setCameraInput,
	skipCameraWindow,
}: {
	setMicInput: (name: string | null) => Promise<unknown>;
	setCameraInput: SetCameraInput;
	skipCameraWindow?: SkipCameraWindow;
}): RecordingInputHandlers {
	const getSkipCameraWindow = () =>
		typeof skipCameraWindow === "function"
			? skipCameraWindow()
			: skipCameraWindow;

	const suspendRecordingInputsForScreenshot = async () => {
		await Promise.all([
			setMicInput(null).catch((error) =>
				console.error(
					"Failed to suspend mic input for screenshot mode:",
					error,
				),
			),
			setCameraInput({
				model: null,
				skipCameraWindow: getSkipCameraWindow(),
			}).catch((error) =>
				console.error(
					"Failed to suspend camera input for screenshot mode:",
					error,
				),
			),
		]);
	};

	const restoreRecordingInputs = async (
		micName: string | null,
		cameraID: DeviceOrModelID | null,
	) => {
		if (micName != null) {
			await setMicInput(micName).catch((error) =>
				console.error("Failed to set mic input:", error),
			);
		}

		if (cameraID != null) {
			await setCameraInput({
				model: cameraID,
				skipCameraWindow: getSkipCameraWindow(),
			}).catch((error) => console.error("Failed to set camera input:", error));
		}
	};

	const syncRecordingInputsForMode = async ({
		mode,
		micName,
		cameraID,
	}: {
		mode: RecordingMode;
		micName: string | null;
		cameraID: DeviceOrModelID | null;
	}) => {
		if (mode === "screenshot") {
			await suspendRecordingInputsForScreenshot();
		} else {
			await restoreRecordingInputs(micName, cameraID);
		}
	};

	return {
		restoreRecordingInputs,
		suspendRecordingInputsForScreenshot,
		syncRecordingInputsForMode,
	};
}
