import "../content/bootstrap";
import { RECORDER_OPEN_PARAM } from "./recorder-pages";
import { sendServiceWorkerMessage } from "./runtime";

// A Cap page opened in place of a browser page asks for the recorder once,
// then drops the flag so a reload does not reopen it.
export const openRequestedRecorder = () => {
	const url = new URL(window.location.href);
	if (url.searchParams.get(RECORDER_OPEN_PARAM) !== "open") return;
	url.searchParams.delete(RECORDER_OPEN_PARAM);
	window.history.replaceState(null, "", url);
	void sendServiceWorkerMessage({
		target: "service-worker",
		type: "show-recorder-panel",
	}).catch(() => undefined);
};
