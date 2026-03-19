export const NO_MICROPHONE = "No Microphone";
export const NO_MICROPHONE_VALUE = "__no_microphone__";
export const NO_CAMERA = "No Camera";
export const NO_CAMERA_VALUE = "__no_camera__";

export const dialogVariants = {
	hidden: {
		opacity: 0,
		scale: 0.9,
		y: 20,
	},
	visible: {
		opacity: 1,
		scale: 1,
		y: 0,
		transition: {
			type: "spring",
			duration: 0.4,
			damping: 25,
			stiffness: 500,
		},
	},
	exit: {
		opacity: 0,
		scale: 0.95,
		y: 10,
		transition: {
			duration: 0.2,
		},
	},
};

export const DISPLAY_MEDIA_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
	frameRate: { ideal: 30 },
	width: { ideal: 1920 },
	height: { ideal: 1080 },
};

export type ExtendedDisplayMediaStreamOptions = DisplayMediaStreamOptions & {
	monitorTypeSurfaces?: "include" | "exclude";
	surfaceSwitching?: "include" | "exclude";
	selfBrowserSurface?: "include" | "exclude";
	preferCurrentTab?: boolean;
	systemAudio?: "include" | "exclude";
};

export type DetectedDisplayRecordingMode = Exclude<
	import("./RecordingModeSelector").RecordingMode,
	"camera"
>;

export type DisplaySurfacePreference =
	| "monitor"
	| "window"
	| "browser"
	| "application";

export const DISPLAY_MODE_PREFERENCES: Record<
	DetectedDisplayRecordingMode,
	Partial<ExtendedDisplayMediaStreamOptions>
> = {
	fullscreen: {
		monitorTypeSurfaces: "include",
		selfBrowserSurface: "exclude",
		surfaceSwitching: "exclude",
		preferCurrentTab: false,
	},
	window: {
		monitorTypeSurfaces: "exclude",
		selfBrowserSurface: "exclude",
		surfaceSwitching: "exclude",
		preferCurrentTab: false,
	},
	tab: {
		monitorTypeSurfaces: "exclude",
		selfBrowserSurface: "include",
		surfaceSwitching: "exclude",
		preferCurrentTab: true,
	},
};

export const DISPLAY_SURFACE_TO_RECORDING_MODE: Record<
	string,
	DetectedDisplayRecordingMode
> = {
	monitor: "fullscreen",
	screen: "fullscreen",
	window: "window",
	application: "window",
	browser: "tab",
	tab: "tab",
};

export const RECORDING_MODE_TO_DISPLAY_SURFACE: Record<
	DetectedDisplayRecordingMode,
	DisplaySurfacePreference
> = {
	fullscreen: "monitor",
	window: "window",
	tab: "browser",
};

export const MP4_MIME_TYPES = {
	withAudio: [
		'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
		'video/mp4;codecs="avc1.4d401e,mp4a.40.2"',
	],
	videoOnly: [
		'video/mp4;codecs="avc1.42E01E"',
		'video/mp4;codecs="avc1.4d401e"',
		"video/mp4",
	],
} as const;

export const WEBM_MIME_TYPES = {
	withAudio: ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus"],
	videoOnly: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"],
} as const;

export const DETECTION_RETRY_DELAYS = [120, 450, 1000];

export const FREE_PLAN_MAX_RECORDING_MS = 5 * 60 * 1000;
