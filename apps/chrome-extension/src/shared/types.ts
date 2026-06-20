import type {
	DetectedDisplayRecordingMode,
	RecordingPipeline,
	UploadStatus,
	VideoId,
} from "@cap/recorder-core";
import type { Extension, Video } from "@cap/web-domain";

export const DEFAULT_CAMERA_DEVICE_ID = "__cap_default_camera__";
export const DEFAULT_MICROPHONE_DEVICE_ID = "__cap_default_microphone__";

export type CameraDevice = {
	deviceId: string;
	label: string;
	groupId: string;
};

export type MicrophoneDevice = {
	deviceId: string;
	label: string;
	groupId: string;
};

// Derived from recorder-core's display-mode union so the two cannot drift.
export type RecordingMode = DetectedDisplayRecordingMode | "camera";

export type DevicePreference = {
	deviceId: string;
	label: string | null;
	groupId: string | null;
	updatedAt: number;
};

export type CapturePreferences = {
	recordingMode: RecordingMode;
	camera: DevicePreference | null;
	microphone: DevicePreference | null;
};

export type WebcamShape = "round" | "square" | "full";
export type WebcamPosition =
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right";

export type WebcamSettings = {
	enabled: boolean;
	deviceId: string | null;
	position: WebcamPosition;
	size: number;
	shape: WebcamShape;
	mirror: boolean;
};

export type OverlayPosition = {
	x: number;
	y: number;
	viewportWidth: number;
	viewportHeight: number;
	updatedAt: number;
};

export type OverlayUiState = {
	webcamPosition: OverlayPosition | null;
	recordingBarPosition: OverlayPosition | null;
};

export type WebcamPreviewFrame = {
	dataUrl: string;
	dimensions: {
		width: number;
		height: number;
	};
	capturedAt: number;
};

export type MicrophoneSettings = {
	enabled: boolean;
	deviceId: string | null;
};

export type SystemAudioSettings = {
	enabled: boolean;
};

export type SoundSettings = {
	enabled: boolean;
};

// Pre-roll countdown shown on the recorded/active tab right before the first
// frame is captured. `seconds` doubles as the number it counts down from.
export type CountdownSettings = {
	enabled: boolean;
	seconds: number;
};

// Whether to interrupt a recording start with a confirm prompt when the mic is
// off or producing no sound. The check runs in the offscreen recorder and the
// prompt shows as a floating overlay on the recorded tab.
export type MicrophoneWarningSettings = {
	enabled: boolean;
};

// "no-mic" — recording with the microphone disabled; "no-sound" — a mic is
// selected but the offscreen probe heard nothing from it.
export type MicrophoneWarningVariant = "no-mic" | "no-sound";

export type ExtensionSettings = {
	apiBaseUrl: string;
	capture: CapturePreferences;
	webcam: WebcamSettings;
	microphone: MicrophoneSettings;
	systemAudio: SystemAudioSettings;
	sounds: SoundSettings;
	countdown: CountdownSettings;
	microphoneWarning: MicrophoneWarningSettings;
};

export type ExtensionAuth = {
	authApiKey: string;
	userId: string;
};

export type PendingAuth = {
	state: string;
	redirectUri: string;
	startedAt: number;
};

// Derived from the server schema so contract drift fails to compile instead
// of surfacing at runtime.
export type BootstrapData = typeof Extension.ExtensionBootstrapSuccess.Type;

export type RecordingPlan = BootstrapData["plan"];

export type RecordingCaptureSource = {
	requestedMode: RecordingMode;
	detectedMode: RecordingMode | null;
	displaySurface: string | null;
	label: string | null;
	tabId?: number;
};

// Aggregated upload progress: statuses are broadcast and persisted to session
// storage frequently, so they carry totals instead of a per-part chunk array
// that grows by one entry per ~5MB for the length of the recording.
export type UploadSummary = {
	totalBytes: number;
	uploadedBytes: number;
	totalChunks: number;
	completedChunks: number;
	failedChunks: number;
};

export type RecordingStatus =
	| {
			phase: "idle";
	  }
	| {
			phase: "creating";
	  }
	| {
			phase: "recording" | "paused" | "uploading";
			videoId?: VideoId;
			startedAt: number;
			durationMs: number;
			updatedAt: number;
			uploadStatus?: UploadStatus;
			upload?: UploadSummary;
	  }
	| {
			phase: "completed";
			videoId: VideoId;
			shareUrl: string;
	  }
	| {
			phase: "error";
			message: string;
			videoId?: VideoId;
			// Set when the upload completed but the confirmation was lost: the
			// video may still process server-side, so the user should verify
			// before retrying.
			shareUrl?: string;
			// Set when the recording data is still spooled locally and can be
			// retried or downloaded from the upload page.
			recoverable?: boolean;
	  };

export type StartRecordingRequest = {
	target: "offscreen";
	type: "start-recording";
	mode: RecordingMode;
	settings: ExtensionSettings;
	auth: ExtensionAuth;
	bootstrap: BootstrapData;
	tabId?: number;
	tabStreamId?: string;
};

export type StopRecordingRequest = {
	target: "offscreen";
	type: "stop-recording";
};

export type PauseRecordingRequest = {
	target: "offscreen";
	type: "pause-recording";
};

export type ResumeRecordingRequest = {
	target: "offscreen";
	type: "resume-recording";
};

export type GetRecordingStatusRequest = {
	target: "offscreen";
	type: "get-recording-status";
};

export type ConnectCameraPreviewRequest = {
	target: "offscreen";
	type: "connect-camera-preview";
	sessionId: string;
	settings: WebcamSettings;
	offer: RTCSessionDescriptionInit;
};

export type DisconnectCameraPreviewRequest = {
	target: "offscreen";
	type: "disconnect-camera-preview";
	sessionId: string;
};

export type DisconnectCameraPreviewsRequest = {
	target: "offscreen";
	type: "disconnect-camera-previews";
};

export type AcknowledgeErrorRequest = {
	target: "offscreen";
	type: "acknowledge-error";
};

export type RetryUploadRequest = {
	target: "offscreen";
	type: "retry-upload";
	videoId: string;
};

export type EnumerateDevicesRequest = {
	target: "offscreen";
	type: "enumerate-devices";
};

// Opens the selected mic briefly and listens for any signal, so the recorder
// can warn before starting. Runs in the offscreen document because its
// AudioContext is not gated by the page autoplay policy the way a popup's is.
export type ProbeMicrophoneRequest = {
	target: "offscreen";
	type: "probe-microphone";
	microphone: MicrophoneSettings;
};

export type MicrophoneProbeResult = {
	// False when the mic could not be opened at all (no device/permission).
	available: boolean;
	// True when any sound cleared the silence threshold during the probe.
	hasSound: boolean;
};

export type MediaDeviceList = {
	cameras: CameraDevice[];
	microphones: MicrophoneDevice[];
};

export type OffscreenRequest =
	| StartRecordingRequest
	| StopRecordingRequest
	| PauseRecordingRequest
	| ResumeRecordingRequest
	| GetRecordingStatusRequest
	| ConnectCameraPreviewRequest
	| DisconnectCameraPreviewRequest
	| DisconnectCameraPreviewsRequest
	| AcknowledgeErrorRequest
	| RetryUploadRequest
	| EnumerateDevicesRequest
	| ProbeMicrophoneRequest;

export type OffscreenResponse =
	| {
			ok: true;
			status?: RecordingStatus;
			answer?: RTCSessionDescriptionInit;
			devices?: MediaDeviceList;
			micProbe?: MicrophoneProbeResult;
	  }
	| {
			ok: false;
			error: string;
			// True when the user dismissed the capture picker rather than the
			// recording failing; callers skip the error UI for cancellations.
			canceled?: boolean;
	  };

export type ServiceWorkerRequest =
	| {
			target: "service-worker";
			type: "auth-start";
	  }
	| {
			target: "service-worker";
			type: "auth-revoke";
	  }
	| {
			target: "service-worker";
			type: "bootstrap";
	  }
	| {
			target: "service-worker";
			type: "get-overlay-settings";
	  }
	| {
			target: "service-worker";
			type: "get-camera-devices";
	  }
	| {
			// Asks the offscreen document (a top-level extension page that holds the
			// camera/mic grant) to enumerate devices, since the recorder panel runs
			// as a cross-origin iframe where Chrome withholds device labels.
			target: "service-worker";
			type: "get-media-devices";
	  }
	| {
			target: "service-worker";
			type: "camera-devices-updated";
			devices: CameraDevice[];
	  }
	| {
			target: "service-worker";
			type: "start-recording";
			mode: RecordingMode;
	  }
	| {
			target: "service-worker";
			type: "stop-recording";
	  }
	| {
			target: "service-worker";
			type: "pause-recording";
	  }
	| {
			target: "service-worker";
			type: "resume-recording";
	  }
	| {
			target: "service-worker";
			type: "get-recording-status";
	  }
	| {
			target: "service-worker";
			type: "open-options";
	  }
	| {
			target: "service-worker";
			type: "open-how-it-works";
	  }
	| {
			target: "service-worker";
			type: "close-extension-ui";
	  }
	| {
			target: "service-worker";
			type: "settings-updated";
			settings: ExtensionSettings;
	  }
	| {
			target: "service-worker";
			type: "close-webcam-preview";
	  }
	| {
			target: "service-worker";
			type: "connect-camera-preview";
			sessionId: string;
			settings: WebcamSettings;
			offer: RTCSessionDescriptionInit;
	  }
	| {
			target: "service-worker";
			type: "disconnect-camera-preview";
			sessionId: string;
	  }
	| {
			target: "service-worker";
			type: "webcam-preview-ready";
	  }
	| {
			target: "service-worker";
			type: "recording-capture-source";
			source: RecordingCaptureSource;
	  }
	| {
			target: "service-worker";
			type: "webcam-preview-error";
			reason: CameraPreviewErrorReason;
			message: string;
	  }
	| {
			// Camera preview iframe → service worker → embedding tab's content
			// script. The iframe must not window.postMessage these to its parent:
			// the parent is the recorded page, which could read webcam frames out
			// of the message stream.
			target: "service-worker";
			type: "camera-preview-event";
			token: string;
			event: CameraPreviewEvent;
	  }
	| {
			// Content scripts announce the token their extension iframes (camera
			// preview, recorder panel) carry in their URL hash. The service
			// worker only honours camera requests from frames whose token was
			// registered this way, which web pages cannot do.
			target: "service-worker";
			type: "register-overlay-token";
			token: string;
	  }
	| {
			target: "service-worker";
			type: "validate-overlay-token";
			token: string;
	  }
	| {
			target: "service-worker";
			type: "retry-upload";
			videoId: string;
	  }
	| {
			// Offscreen recorder → service worker → recorded tab's content overlay.
			// The offscreen document has no chrome.tabs access, so the worker
			// relays the countdown to the tab on its behalf.
			target: "service-worker";
			type: "show-countdown";
			tabId?: number;
			seconds: number;
			durationMs: number;
	  }
	| {
			// The recorded tab's confirm overlay reports the user's decision back to
			// the service worker, which is blocking the recording start on it.
			target: "service-worker";
			type: "confirm-result";
			requestId: string;
			confirmed: boolean;
	  };

export type ServiceWorkerResponse =
	| {
			ok: true;
			auth?: ExtensionAuth | null;
			authPending?: boolean;
			// Terminal failure of the most recent sign-in attempt; the popup
			// shows it once the pending state clears.
			authError?: string | null;
			bootstrap?: BootstrapData;
			cameraDevices?: CameraDevice[];
			microphoneDevices?: MicrophoneDevice[];
			status?: RecordingStatus;
			settings?: ExtensionSettings;
			plan?: RecordingPlan;
			answer?: RTCSessionDescriptionInit;
			valid?: boolean;
	  }
	| {
			ok: false;
			error: string;
			canceled?: boolean;
	  };

export type OverlayMessage =
	| {
			type: "overlay-settings";
			settings: WebcamSettings;
			recording: boolean;
	  }
	| {
			// Play the pre-roll countdown over the page. `durationMs` mirrors the
			// time the offscreen recorder waits before capturing, so the animation
			// finishes just before the first recorded frame.
			type: "overlay-countdown";
			seconds: number;
			durationMs: number;
	  }
	| {
			// Floating confirm prompt shown in the middle of the recorded/active
			// tab before a recording starts. The decision returns to the service
			// worker via a "confirm-result" request keyed by requestId.
			type: "overlay-confirm";
			requestId: string;
			variant: MicrophoneWarningVariant;
	  }
	| {
			type: "overlay-enter-auto-pip";
	  }
	| {
			type: "overlay-exit-auto-pip";
	  }
	| {
			type: "overlay-hide";
	  }
	| {
			type: "overlay-panel-toggle";
	  }
	| {
			type: "overlay-panel-hide";
	  };

export type RecordingStatusBroadcast = {
	target: "recording-status";
	type: "recording-status-changed";
	status: RecordingStatus;
};

// Mirrored into chrome.storage.session by the service worker so every tab's
// floating UI reads the exact same recording state instead of each tab
// round-tripping for its own copy.
export type SharedRecordingState = {
	status: RecordingStatus;
	plan: RecordingPlan | null;
	updatedAt: number;
};

// Cross-tab UI state: the recorder panel and the ready bar stay in lockstep
// across every tab instead of tracking open/dismissed per tab.
export type SharedUiState = {
	panelOpen: boolean;
	readyBarDismissed: boolean;
	updatedAt: number;
};

export type CameraPreviewErrorReason =
	| "permissions-policy"
	| "permission"
	| "not-found"
	| "in-use"
	| "unknown";

// Events the camera preview iframe reports to the overlay that embeds it.
// They travel iframe → service worker → chrome.tabs.sendMessage so the host
// page never sees them; webcam frames in particular must not transit
// window.postMessage where the recorded page could listen.
export type CameraPreviewEvent =
	| { type: "ready" }
	| { type: "metadata"; dimensions: { width: number; height: number } }
	| { type: "session"; sessionId: string }
	| { type: "frame"; frame: WebcamPreviewFrame }
	| { type: "error"; reason: CameraPreviewErrorReason; message: string }
	| { type: "pip-state"; active: boolean; supported: boolean }
	| { type: "drag-start"; clientX: number; clientY: number }
	| { type: "drag-move"; clientX: number; clientY: number }
	| { type: "drag-end" };

// Shape of the relayed message a content script receives for the preview
// iframe it embeds; the token scopes it to that tab's overlay.
export type CameraPreviewEventRelay = {
	source: "cap-extension-camera-preview";
	token: string;
	event: CameraPreviewEvent;
};

export type InstantRecordingCreation =
	typeof Video.InstantRecordingCreateSuccess.Type;

export type RecorderSession = {
	videoId: VideoId;
	shareUrl: string;
	pipeline: RecordingPipeline;
};
