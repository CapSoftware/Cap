import { describe, expect, it, vi } from "vitest";

import type { DeviceOrModelID } from "~/utils/tauri";
import { createRecordingInputHandlers } from "./screenshot-recording-inputs";

describe("screenshot-recording-inputs", () => {
	it("restores an empty-string mic label", async () => {
		const setMicInput = vi.fn().mockResolvedValue(undefined);
		const setCameraInput = vi.fn().mockResolvedValue(undefined);
		const cameraID: DeviceOrModelID = { DeviceID: "camera" };
		const { restoreRecordingInputs } = createRecordingInputHandlers({
			setMicInput,
			setCameraInput,
		});

		await restoreRecordingInputs("", cameraID);

		expect(setMicInput).toHaveBeenCalledWith("");
		expect(setCameraInput).toHaveBeenCalledWith({
			model: cameraID,
			skipCameraWindow: undefined,
		});
	});
});
