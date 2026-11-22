export type RecordingMode = "instant" | "studio";

export type StoredRecordingMode = RecordingMode | "screenshot";

export type CaptureMode = { screen: string } | { window: string };

export type CameraDeviceOrModelId = { DeviceID: string } | { ModelID: string };

export interface StartRecordingPayload {
	capture_mode: CaptureMode;
	camera: CameraDeviceOrModelId | null;
	mic_label: string | null;
	capture_system_audio: boolean;
	mode: RecordingMode;
}

export type DeepLinkAction =
	| { start_recording: StartRecordingPayload }
	| "stop_recording"
	| { open_editor: { project_path: string } }
	| { open_settings: { page: string | null } };

export interface StartRecordingArgs {
	mode?: "default" | RecordingMode;
	screen?: string;
}

export interface ExtensionPreferences {
	serverUrl?: string;
	defaultMode?: "default" | RecordingMode;
	defaultScreen?: string;
	cameraDeviceId?: string;
	micLabel?: string;
	systemAudio?: "default" | "enabled" | "disabled";
	recordingsDirectory?: string;
	apiKey?: string;
}

export type StoredScreenCaptureTarget =
	| { variant: "window"; id: string | number }
	| { variant: "display"; id: string | number }
	| { variant: "area"; screen: string | number; bounds?: unknown }
	| { variant: "cameraOnly" }
	| { variant: "audioOnly" };

export interface CapDesktopStoreGeneralSettings {
	serverUrl?: string;
	recordingsPath?: string | null;
	previousRecordingsPaths?: string[];
}

export interface CapDesktopStoreRecordingSettings {
	mode?: StoredRecordingMode;
	target?: StoredScreenCaptureTarget | null;
	cameraId?: CameraDeviceOrModelId | null;
	micName?: string | null;
	systemAudio?: boolean;
}

export interface CapDesktopStoreAuth {
	secret?: {
		api_key?: string;
		token?: string;
	};
	user_id?: string;
}

export interface CapDesktopStore {
	general_settings?: CapDesktopStoreGeneralSettings;
	recording_settings?: CapDesktopStoreRecordingSettings;
	auth?: CapDesktopStoreAuth;
}

export interface CapCliScreenTarget {
	index: number;
	id: string | number;
	name: string;
	fps?: number;
	refreshRate?: number;
	primary: boolean;
}

export interface CapCliWindowTarget {
	index: number;
	id: string | number;
	name: string;
	ownerName: string;
	fps?: number;
	bundleIdentifier?: string;
}

export interface CapCliTargets {
	screens: CapCliScreenTarget[];
	windows: CapCliWindowTarget[];
}

export interface CapRecordingItem {
	id: string;
	title: string;
	mode: RecordingMode;
	createdAt?: string;
	updatedAt?: string;
	durationMs?: number | null;
	shareUrl?: string;
	projectPath?: string;
	source: "local" | "cloud";
	status?: string;
}

export interface CloudCapListItem {
	id: string;
	title?: string | null;
	aiTitle?: string | null;
	shareUrl?: string | null;
	createdAt?: string;
	updatedAt?: string;
	durationMs?: number | null;
	status?: {
		overall?: string;
	};
}

export interface CloudCapsResponse {
	caps?: CloudCapListItem[];
	nextCursor?: string | null;
}
