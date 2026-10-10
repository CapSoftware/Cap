// Chrome's Capture Handle lets a capture of this tab identify itself, so
// sharing some other tab can still preview normally.
const CAPTURE_HANDLE =
	typeof crypto !== "undefined" && "randomUUID" in crypto
		? `cap-recorder-${crypto.randomUUID()}`
		: `cap-recorder-${Date.now()}`;

type CaptureHandleTrack = MediaStreamTrack & {
	getCaptureHandle?: () => { handle?: string } | null;
};

export const identifyThisTab = () => {
	const mediaDevices = navigator.mediaDevices as MediaDevices & {
		setCaptureHandleConfig?: (config: {
			handle: string;
			permittedOrigins: string[];
		}) => void;
	};
	try {
		mediaDevices.setCaptureHandleConfig?.({
			handle: CAPTURE_HANDLE,
			permittedOrigins: [window.location.origin],
		});
	} catch {
		/* older browsers: tab captures just aren't recognised */
	}
};

// Showing a capture of the whole screen, or of this very tab, inside this tab
// repeats the preview inside itself forever.
export const capturesThisTab = (stream: MediaStream | null) => {
	const track = stream?.getVideoTracks()[0] as CaptureHandleTrack | undefined;
	if (!track) return false;
	const surface = (
		track.getSettings() as MediaTrackSettings & { displaySurface?: string }
	).displaySurface;
	if (surface === "monitor") return true;
	if (surface !== "browser") return false;
	try {
		return track.getCaptureHandle?.()?.handle === CAPTURE_HANDLE;
	} catch {
		return false;
	}
};
