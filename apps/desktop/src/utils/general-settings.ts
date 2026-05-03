import type { GeneralSettingsStore as TauriGeneralSettingsStore } from "~/utils/tauri";

export type GeneralSettingsStore = TauriGeneralSettingsStore & {
	captureKeyboardEvents?: boolean;
	transcriptionHints?: string[];
	enableTelemetry?: boolean;
	outOfProcessMuxer?: boolean;
	verboseLogging?: boolean;
};

export const DEFAULT_TRANSCRIPTION_HINTS = [
	"Cap",
	"TypeScript",
	"My Brand Name",
	"mywebsite.com",
];

export function createDefaultGeneralSettings(): GeneralSettingsStore {
	return {
		uploadIndividualFiles: false,
		hideDockIcon: false,
		autoCreateShareableLink: false,
		enableNotifications: true,
		enableNativeCameraPreview: false,
		autoZoomOnClicks: false,
		captureKeyboardEvents: true,
		custom_cursor_capture2: true,
		excludedWindows: [],
		instantModeMaxResolution: 1920,
		crashRecoveryRecording: true,
		maxFps: 60,
		transcriptionHints: [...DEFAULT_TRANSCRIPTION_HINTS],
		enableTelemetry: true,
		verboseLogging: false,
	};
}

export function deriveGeneralSettings(
	store: GeneralSettingsStore | null | undefined,
): GeneralSettingsStore {
	return {
		...createDefaultGeneralSettings(),
		...(store ?? {}),
	};
}

export function normalizeTranscriptionHints(
	hints: readonly string[],
): string[] {
	const normalized: string[] = [];

	for (const hint of hints) {
		const value = hint.replaceAll("\0", "").trim();
		if (!value || normalized.includes(value)) continue;
		normalized.push(value);
	}

	return normalized;
}

export function parseTranscriptionHints(value: string): string[] {
	return normalizeTranscriptionHints(value.split(/\r?\n/));
}

export function formatTranscriptionHints(
	hints: readonly string[] | null | undefined,
): string {
	return normalizeTranscriptionHints(hints ?? []).join("\n");
}
