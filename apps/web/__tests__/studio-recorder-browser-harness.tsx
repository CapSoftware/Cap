import {
	RecordingSpool,
	recoverOrphanedRecordingSpools,
} from "@cap/recorder-core/recording-spool";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useStudioRecorder } from "../app/(org)/dashboard/caps/components/web-recorder-dialog/useStudioRecorder";

declare global {
	interface Window {
		capRecorderHarness?: ReturnType<typeof useStudioRecorder>;
		capRecorderSpool?: typeof RecordingSpool;
		capRecorderRecoverOrphans?: typeof recoverOrphanedRecordingSpools;
	}
}

window.capRecorderSpool = RecordingSpool;
window.capRecorderRecoverOrphans = recoverOrphanedRecordingSpools;

function RecorderHarness() {
	const params = new URLSearchParams(location.search);
	const captureMic = params.get("mic") === "1";
	const recorder = useStudioRecorder({
		organisationId: "test-org",
		selectedMicId: captureMic ? "test-mic" : null,
		micEnabled: captureMic,
		systemAudioEnabled: false,
		recordingMode: "fullscreen",
		selectedCameraId: params.get("camera") === "0" ? null : "test-camera",
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
