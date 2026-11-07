import { execFileSync } from "node:child_process";

export type RecordingMode = "instant" | "studio";

export interface StartRecordingPreferences {
	defaultMode?: RecordingMode;
	defaultScreen?: string;
	cameraDeviceId?: string;
	micLabel?: string;
	captureSystemAudio?: boolean;
}

export interface StopRecordingPreferences {
	copyUrlOnStop?: boolean;
	dashboardUrl?: string;
}

export interface DeepLinkStartPayload {
	start_recording: {
		capture_mode: { screen: string } | { window: string };
		camera: { DeviceID: string } | null;
		mic_label: string | null;
		capture_system_audio: boolean;
		mode: RecordingMode;
	};
}

const CAP_ACTION_BASE_URL = "cap-desktop://action";
const DEFAULT_DASHBOARD_URL = "https://cap.so/dashboard";

function parseFirstDisplayFromSystemProfiler(rawJson: string): string | null {
	try {
		const parsed = JSON.parse(rawJson) as {
			SPDisplaysDataType?: Array<{
				spdisplays_ndrvs?: Array<{ _name?: string }>;
			}>;
		};
		for (const gpu of parsed.SPDisplaysDataType ?? []) {
			for (const display of gpu.spdisplays_ndrvs ?? []) {
				const name = display._name?.trim();
				if (name) {
					return name;
				}
			}
		}
	} catch {
		return null;
	}
	return null;
}

export function detectActiveMacDisplayName(): string | null {
	try {
		const output = execFileSync(
			"system_profiler",
			["SPDisplaysDataType", "-json"],
			{ encoding: "utf8", timeout: 3000 },
		);
		return parseFirstDisplayFromSystemProfiler(output);
	} catch {
		return null;
	}
}

export function resolveTargetScreenName(
	prefs: StartRecordingPreferences,
	detectDisplay: () => string | null = detectActiveMacDisplayName,
): string {
	const configured = prefs.defaultScreen?.trim();
	if (configured) {
		return configured;
	}
	const detected = detectDisplay()?.trim();
	if (detected) {
		return detected;
	}
	throw new Error(
		"No target screen name configured or detected. Set Default Screen Name in Raycast preferences.",
	);
}

export function buildStartRecordingPayload(
	prefs: StartRecordingPreferences,
	detectDisplay: () => string | null = detectActiveMacDisplayName,
): DeepLinkStartPayload {
	const screenName = resolveTargetScreenName(prefs, detectDisplay);
	const cameraId = prefs.cameraDeviceId?.trim();
	const micName = prefs.micLabel?.trim();

	return {
		start_recording: {
			capture_mode: { screen: screenName },
			camera: cameraId ? { DeviceID: cameraId } : null,
			mic_label: micName || null,
			capture_system_audio: prefs.captureSystemAudio ?? true,
			mode: prefs.defaultMode || "instant",
		},
	};
}

export function encodeCapActionUrl(actionValue: unknown): string {
	const serialized = JSON.stringify(actionValue);
	return `${CAP_ACTION_BASE_URL}?value=${encodeURIComponent(serialized)}`;
}

export function buildStartRecordingDeepLink(
	prefs: StartRecordingPreferences = {},
	detectDisplay: () => string | null = detectActiveMacDisplayName,
): string {
	return encodeCapActionUrl(buildStartRecordingPayload(prefs, detectDisplay));
}

export function buildStopRecordingDeepLink(): string {
	return encodeCapActionUrl("stop_recording");
}

export function resolveDashboardUrl(customUrl?: string): string {
	const trimmed = customUrl?.trim();
	if (!trimmed) {
		return DEFAULT_DASHBOARD_URL;
	}
	return trimmed.replace(/\/+$/, "");
}

export function extractShareableCapUrl(
	clipboardText: string | undefined,
	dashboardBaseUrl?: string,
): string | null {
	if (!clipboardText) {
		return null;
	}
	const trimmed = clipboardText.trim();
	const customOrigin = resolveDashboardUrl(dashboardBaseUrl).replace(
		/\/dashboard$/,
		"",
	);
	const isCapLink =
		trimmed.startsWith("https://cap.so/s/") ||
		trimmed.startsWith("https://cap.link/") ||
		(customOrigin.startsWith("http") &&
			trimmed.startsWith(`${customOrigin}/s/`));

	return isCapLink ? trimmed : null;
}
