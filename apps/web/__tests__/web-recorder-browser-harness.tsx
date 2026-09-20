import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useWebRecorder } from "../app/(org)/dashboard/caps/components/web-recorder-dialog/useWebRecorder";

declare global {
	interface Window {
		capRecorderHarness?: ReturnType<typeof useWebRecorder>;
	}
}

function RecorderHarness() {
	const captureMic = new URLSearchParams(location.search).get("mic") === "1";
	const recorder = useWebRecorder({
		organisationId: "test-org",
		selectedMicId: captureMic ? "test-mic" : null,
		micEnabled: captureMic,
		systemAudioEnabled: false,
		recordingMode: "fullscreen",
		selectedCameraId: "test-camera",
		getCameraPreviewStream: () => null,
		isProUser: true,
	});
	useEffect(() => {
		window.capRecorderHarness = recorder;
	});
	return <main data-phase={recorder.phase}>{recorder.phase}</main>;
}

const element = document.getElementById("root");
if (!element) throw new Error("Recorder replay root is unavailable");
createRoot(element).render(<RecorderHarness />);
