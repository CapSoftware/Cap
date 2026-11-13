import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getPreferenceValues, open } from "@raycast/api";

export type RecordingModeOverride = "default" | "instant" | "studio";

interface ExtensionPreferences {
	serverUrl?: string;
}

export function buildDeepLink(
	actionPayload: unknown,
	scheme: "cap-desktop" | "cap" = "cap-desktop",
): string {
	const value = JSON.stringify(actionPayload);
	return `${scheme}://action?value=${encodeURIComponent(value)}`;
}

export function buildStartDefaultRecordingAction(mode?: RecordingModeOverride): {
	start_default_recording: { mode?: "instant" | "studio" };
} {
	if (mode === "instant" || mode === "studio") {
		return { start_default_recording: { mode } };
	}
	return { start_default_recording: {} };
}

export async function triggerCapAction(actionPayload: unknown): Promise<void> {
	try {
		await open(buildDeepLink(actionPayload, "cap-desktop"));
	} catch {
		await open(buildDeepLink(actionPayload, "cap"));
	}
}

export function resolveCapStorePath(): string {
	const overridePath = process.env.CAP_GPUI_TAURI_STORE?.trim();
	if (overridePath) {
		return overridePath;
	}
	const appDataOverride = process.env.CAP_GPUI_APP_DATA_DIR?.trim();
	if (appDataOverride) {
		return join(appDataOverride, "store");
	}
	if (process.platform === "darwin") {
		return join(
			homedir(),
			"Library",
			"Application Support",
			"so.cap.desktop",
			"store",
		);
	}
	if (process.platform === "win32") {
		const appData = process.env.APPDATA || homedir();
		return join(appData, "so.cap.desktop", "store");
	}
	const xdgData =
		process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return join(xdgData, "so.cap.desktop", "store");
}

export function readStoredServerUrl(
	storePath = resolveCapStorePath(),
): string | undefined {
	try {
		const raw = readFileSync(storePath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) {
			return undefined;
		}
		const general = (parsed as Record<string, unknown>).general_settings;
		if (typeof general !== "object" || general === null) {
			return undefined;
		}
		const serverUrl = (general as Record<string, unknown>).serverUrl;
		if (typeof serverUrl === "string" && serverUrl.trim().length > 0) {
			return serverUrl.trim();
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function resolveDashboardUrl(
	preferenceServerUrl?: string,
	storedServerUrl?: string,
): string {
	const candidate =
		preferenceServerUrl?.trim() || storedServerUrl?.trim() || "https://cap.so";
	const normalized = candidate.replace(/\/+$/, "");
	return normalized.endsWith("/dashboard")
		? normalized
		: `${normalized}/dashboard`;
}

export function getConfiguredDashboardUrl(): string {
	const preferences = getPreferenceValues<ExtensionPreferences>();
	return resolveDashboardUrl(preferences.serverUrl, readStoredServerUrl());
}
