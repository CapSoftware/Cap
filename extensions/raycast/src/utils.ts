import { execFileSync } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
	CameraDeviceOrModelId,
	CapCliScreenTarget,
	CapCliTargets,
	CapCliWindowTarget,
	CapDesktopStore,
	CapRecordingItem,
	CaptureMode,
	CloudCapsResponse,
	DeepLinkAction,
	ExtensionPreferences,
	RecordingMode,
	StartRecordingArgs,
	StartRecordingPayload,
	StoredRecordingMode,
	StoredScreenCaptureTarget,
} from "./types";

export const DEFAULT_SERVER_URL = "https://cap.so";

const DESKTOP_BUNDLE_ID = "so.cap.desktop";

const ACTIVE_SCREEN_JXA_SCRIPT = [
	'ObjC.import("AppKit");',
	"function unwrap(v) { return typeof ObjC.unwrap === 'function' ? ObjC.unwrap(v) : v; }",
	"var mouse = $.NSEvent.mouseLocation;",
	"var screens = $.NSScreen.screens;",
	"var count = screens.count;",
	"var chosen = null;",
	"for (var i = 0; i < count; i++) {",
	"\tvar s = screens.objectAtIndex(i);",
	"\tvar f = s.frame;",
	"\tif (mouse.x >= f.origin.x && mouse.x < (f.origin.x + f.size.width) && mouse.y >= f.origin.y && mouse.y < (f.origin.y + f.size.height)) {",
	"\t\tchosen = unwrap(s.localizedName);",
	"\t\tbreak;",
	"\t}",
	"}",
	"if (!chosen && $.NSScreen.mainScreen) {",
	"\tchosen = unwrap($.NSScreen.mainScreen.localizedName);",
	"}",
	'chosen ? String(chosen) : "";',
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildDeepLinkUrl(
	action: DeepLinkAction,
	scheme: "cap-desktop" | "cap" = "cap-desktop",
): string {
	const encoded = encodeURIComponent(JSON.stringify(action));
	return `${scheme}://action?value=${encoded}`;
}

export function buildStartRecordingUrl(
	payload: StartRecordingPayload,
	scheme: "cap-desktop" | "cap" = "cap-desktop",
): string {
	return buildDeepLinkUrl({ start_recording: payload }, scheme);
}

export function buildStopRecordingUrl(
	scheme: "cap-desktop" | "cap" = "cap-desktop",
): string {
	return buildDeepLinkUrl("stop_recording", scheme);
}

export function buildOpenEditorUrl(
	projectPath: string,
	scheme: "cap-desktop" | "cap" = "cap-desktop",
): string {
	return buildDeepLinkUrl(
		{ open_editor: { project_path: projectPath } },
		scheme,
	);
}

export function buildOpenSettingsUrl(
	page: string | null = null,
	scheme: "cap-desktop" | "cap" = "cap-desktop",
): string {
	return buildDeepLinkUrl({ open_settings: { page } }, scheme);
}

export function resolveCapAppDataDir(
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
): string {
	const override = env.CAP_GPUI_APP_DATA_DIR?.trim();
	if (override) {
		return override;
	}
	if (platform === "darwin") {
		return join(home, "Library", "Application Support", DESKTOP_BUNDLE_ID);
	}
	if (platform === "win32") {
		const appData = env.APPDATA?.trim() || join(home, "AppData", "Roaming");
		return join(appData, DESKTOP_BUNDLE_ID);
	}
	const xdgData = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
	return join(xdgData, DESKTOP_BUNDLE_ID);
}

export function resolveCapStorePath(
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
): string {
	const override = env.CAP_GPUI_TAURI_STORE?.trim();
	if (override) {
		return override;
	}
	return join(resolveCapAppDataDir(platform, home, env), "store");
}

export function parseStoredCameraId(
	raw: unknown,
): CameraDeviceOrModelId | null {
	if (!isRecord(raw)) {
		return null;
	}
	const keys = Object.keys(raw);
	if (keys.length !== 1) {
		return null;
	}
	if (typeof raw.DeviceID === "string" && raw.DeviceID.trim().length > 0) {
		return { DeviceID: raw.DeviceID.trim() };
	}
	if (typeof raw.ModelID === "string" && raw.ModelID.trim().length > 0) {
		return { ModelID: raw.ModelID.trim() };
	}
	return null;
}

export function parseStoredTarget(
	raw: unknown,
): StoredScreenCaptureTarget | null {
	if (!isRecord(raw) || typeof raw.variant !== "string") {
		return null;
	}
	if (
		raw.variant === "window" &&
		(typeof raw.id === "number" ||
			(typeof raw.id === "string" && raw.id.trim().length > 0))
	) {
		return { variant: "window", id: raw.id };
	}
	if (
		raw.variant === "display" &&
		(typeof raw.id === "number" ||
			(typeof raw.id === "string" && raw.id.trim().length > 0))
	) {
		return { variant: "display", id: raw.id };
	}
	if (
		raw.variant === "area" &&
		(typeof raw.screen === "number" ||
			(typeof raw.screen === "string" && raw.screen.trim().length > 0))
	) {
		return { variant: "area", screen: raw.screen, bounds: raw.bounds };
	}
	if (raw.variant === "cameraOnly") {
		return { variant: "cameraOnly" };
	}
	if (raw.variant === "audioOnly") {
		return { variant: "audioOnly" };
	}
	return null;
}

export function readCapDesktopStore(
	storePath: string = resolveCapStorePath(),
): CapDesktopStore | null {
	if (!existsSync(storePath)) {
		return null;
	}
	try {
		const rawText = readFileSync(storePath, "utf8");
		if (!rawText.trim()) {
			return null;
		}
		const parsed: unknown = JSON.parse(rawText);
		if (!isRecord(parsed)) {
			return null;
		}
		const store: CapDesktopStore = {};
		if (isRecord(parsed.general_settings)) {
			const gs = parsed.general_settings;
			store.general_settings = {
				serverUrl: typeof gs.serverUrl === "string" ? gs.serverUrl : undefined,
				recordingsPath:
					typeof gs.recordingsPath === "string" ? gs.recordingsPath : null,
				previousRecordingsPaths: Array.isArray(gs.previousRecordingsPaths)
					? gs.previousRecordingsPaths.filter(
							(item): item is string => typeof item === "string",
						)
					: undefined,
			};
		}
		if (isRecord(parsed.recording_settings)) {
			const rs = parsed.recording_settings;
			const mode =
				rs.mode === "instant" ||
				rs.mode === "studio" ||
				rs.mode === "screenshot"
					? (rs.mode as StoredRecordingMode)
					: undefined;
			store.recording_settings = {
				mode,
				target: parseStoredTarget(rs.target),
				cameraId: parseStoredCameraId(rs.cameraId),
				micName:
					typeof rs.micName === "string" && rs.micName.trim().length > 0
						? rs.micName.trim()
						: null,
				systemAudio:
					typeof rs.systemAudio === "boolean" ? rs.systemAudio : undefined,
			};
		}
		if (isRecord(parsed.auth)) {
			const auth = parsed.auth;
			const secret = isRecord(auth.secret)
				? {
						api_key:
							typeof auth.secret.api_key === "string"
								? auth.secret.api_key
								: undefined,
						token:
							typeof auth.secret.token === "string"
								? auth.secret.token
								: undefined,
					}
				: undefined;
			store.auth = {
				secret,
				user_id: typeof auth.user_id === "string" ? auth.user_id : undefined,
			};
		}
		return store;
	} catch {
		return null;
	}
}

export function normalizeServerOrigin(rawServerUrl?: string): string {
	const candidate = rawServerUrl?.trim()
		? rawServerUrl.trim()
		: DEFAULT_SERVER_URL;
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		throw new Error(
			`Invalid Cap Server URL: "${candidate}". Expected a valid HTTP or HTTPS URL.`,
		);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(
			`Unsupported protocol "${parsed.protocol}" in Cap Server URL.`,
		);
	}
	if (parsed.username || parsed.password) {
		throw new Error("Cap Server URL must not include embedded credentials.");
	}
	return parsed.origin;
}

export function resolveServerOrigin(
	preferences: ExtensionPreferences,
	store?: CapDesktopStore | null,
): string {
	const effectiveStore = store === undefined ? readCapDesktopStore() : store;
	const candidate =
		preferences.serverUrl?.trim() ||
		process.env.CAP_SERVER_URL?.trim() ||
		effectiveStore?.general_settings?.serverUrl?.trim() ||
		DEFAULT_SERVER_URL;
	return normalizeServerOrigin(candidate);
}

export function resolveDashboardUrl(
	preferences: ExtensionPreferences,
	store?: CapDesktopStore | null,
): string {
	const origin = resolveServerOrigin(preferences, store);
	return `${origin}/dashboard`;
}

export function resolveRecordingMode(
	args: StartRecordingArgs,
	preferences: ExtensionPreferences,
	store?: CapDesktopStore | null,
): RecordingMode {
	if (args.mode === "instant" || args.mode === "studio") {
		return args.mode;
	}
	if (
		preferences.defaultMode === "instant" ||
		preferences.defaultMode === "studio"
	) {
		return preferences.defaultMode;
	}
	const effectiveStore = store === undefined ? readCapDesktopStore() : store;
	const storedMode = effectiveStore?.recording_settings?.mode;
	if (storedMode === "instant" || storedMode === "studio") {
		return storedMode;
	}
	return "instant";
}

export function resolveCameraSelection(
	preferences: ExtensionPreferences,
	store?: CapDesktopStore | null,
): CameraDeviceOrModelId | null {
	const override = preferences.cameraDeviceId?.trim();
	if (override) {
		return { DeviceID: override };
	}
	const effectiveStore = store === undefined ? readCapDesktopStore() : store;
	return effectiveStore?.recording_settings?.cameraId ?? null;
}

export function resolveMicLabel(
	preferences: ExtensionPreferences,
	store?: CapDesktopStore | null,
): string | null {
	const override = preferences.micLabel?.trim();
	if (override) {
		return override;
	}
	const effectiveStore = store === undefined ? readCapDesktopStore() : store;
	return effectiveStore?.recording_settings?.micName ?? null;
}

export function resolveSystemAudio(
	preferences: ExtensionPreferences,
	store?: CapDesktopStore | null,
): boolean {
	if (preferences.systemAudio === "enabled") {
		return true;
	}
	if (preferences.systemAudio === "disabled") {
		return false;
	}
	const effectiveStore = store === undefined ? readCapDesktopStore() : store;
	return effectiveStore?.recording_settings?.systemAudio ?? false;
}

export function parseCapCliTargetsJson(rawJson: string): CapCliTargets | null {
	try {
		const parsed: unknown = JSON.parse(rawJson);
		if (!isRecord(parsed)) {
			return null;
		}
		const screens: CapCliScreenTarget[] = Array.isArray(parsed.screens)
			? parsed.screens
					.filter(isRecord)
					.map((item, idx) => ({
						index: typeof item.index === "number" ? item.index : idx,
						id:
							typeof item.id === "number" || typeof item.id === "string"
								? item.id
								: String(idx),
						name: typeof item.name === "string" ? item.name.trim() : "",
						fps: typeof item.fps === "number" ? item.fps : undefined,
						refreshRate:
							typeof item.refreshRate === "number"
								? item.refreshRate
								: undefined,
						primary: item.primary === true,
					}))
					.filter((item) => item.name.length > 0)
			: [];
		const windows: CapCliWindowTarget[] = Array.isArray(parsed.windows)
			? parsed.windows
					.filter(isRecord)
					.map((item, idx) => ({
						index: typeof item.index === "number" ? item.index : idx,
						id:
							typeof item.id === "number" || typeof item.id === "string"
								? item.id
								: String(idx),
						name: typeof item.name === "string" ? item.name.trim() : "",
						ownerName:
							typeof item.ownerName === "string" ? item.ownerName.trim() : "",
						fps: typeof item.fps === "number" ? item.fps : undefined,
						bundleIdentifier:
							typeof item.bundleIdentifier === "string"
								? item.bundleIdentifier
								: undefined,
					}))
					.filter((item) => item.name.length > 0)
			: [];
		return { screens, windows };
	} catch {
		return null;
	}
}

export function queryCapCliTargets(
	home: string = homedir(),
): CapCliTargets | null {
	const candidatePaths = [
		join(home, ".cap", "bin", "cap"),
		join(home, ".local", "bin", "cap"),
		"/Applications/Cap.app/Contents/MacOS/cap-cli",
		"/Applications/Cap.app/Contents/Resources/cap-cli",
		"cap",
	];
	for (const bin of candidatePaths) {
		if (bin !== "cap" && !existsSync(bin)) {
			continue;
		}
		try {
			const output = execFileSync(bin, ["targets", "--json"], {
				encoding: "utf8",
				timeout: 2500,
			});
			const parsed = parseCapCliTargetsJson(output);
			if (parsed && (parsed.screens.length > 0 || parsed.windows.length > 0)) {
				return parsed;
			}
		} catch {}
	}
	return null;
}

export function parseSystemProfilerDisplays(rawJson: string): string[] {
	try {
		const parsed: unknown = JSON.parse(rawJson);
		if (!isRecord(parsed) || !Array.isArray(parsed.SPDisplaysDataType)) {
			return [];
		}
		const names: string[] = [];
		for (const gpu of parsed.SPDisplaysDataType) {
			if (!isRecord(gpu) || !Array.isArray(gpu.spdisplays_ndrvs)) {
				continue;
			}
			for (const display of gpu.spdisplays_ndrvs) {
				if (!isRecord(display)) {
					continue;
				}
				const name =
					typeof display._name === "string" ? display._name.trim() : "";
				if (
					name &&
					name !== "spdisplays_display_connector" &&
					!names.includes(name)
				) {
					names.push(name);
				}
			}
		}
		return names;
	} catch {
		return [];
	}
}

export function detectActiveMacScreenName(): string | null {
	if (process.platform !== "darwin") {
		return null;
	}
	try {
		const jxaOutput = execFileSync(
			"/usr/bin/osascript",
			["-l", "JavaScript", "-e", ACTIVE_SCREEN_JXA_SCRIPT],
			{
				encoding: "utf8",
				timeout: 2000,
			},
		).trim();
		if (jxaOutput.length > 0) {
			return jxaOutput;
		}
	} catch {}
	try {
		const profilerOutput = execFileSync(
			"/usr/sbin/system_profiler",
			["SPDisplaysDataType", "-json"],
			{
				encoding: "utf8",
				timeout: 3000,
			},
		);
		const displays = parseSystemProfilerDisplays(profilerOutput);
		if (displays.length === 1) {
			return displays[0];
		}
	} catch {}
	return null;
}

export interface TargetResolutionOptions {
	args: StartRecordingArgs;
	preferences: ExtensionPreferences;
	store: CapDesktopStore | null;
	cliTargets: CapCliTargets | null;
	activeScreenName: string | null;
}

export function resolveCaptureModeFromSources(
	options: TargetResolutionOptions,
): CaptureMode {
	const argScreen = options.args.screen?.trim();
	if (argScreen) {
		return { screen: argScreen };
	}
	const prefScreen = options.preferences.defaultScreen?.trim();
	if (prefScreen) {
		return { screen: prefScreen };
	}
	const savedTarget = options.store?.recording_settings?.target;
	const cliTargets = options.cliTargets;
	if (savedTarget && cliTargets) {
		if (savedTarget.variant === "window") {
			const matchedWindow = cliTargets.windows.find(
				(win) =>
					String(win.id) === String(savedTarget.id) &&
					win.name.trim().length > 0,
			);
			if (matchedWindow) {
				return { window: matchedWindow.name.trim() };
			}
		}
		if (savedTarget.variant === "display" || savedTarget.variant === "area") {
			const displayId =
				savedTarget.variant === "display" ? savedTarget.id : savedTarget.screen;
			const matchedScreen = cliTargets.screens.find(
				(scr) =>
					String(scr.id) === String(displayId) && scr.name.trim().length > 0,
			);
			if (matchedScreen) {
				return { screen: matchedScreen.name.trim() };
			}
		}
	}
	const activeScreen = options.activeScreenName?.trim();
	if (activeScreen) {
		if (cliTargets && cliTargets.screens.length > 0) {
			const matchedActive = cliTargets.screens.find(
				(scr) => scr.name.trim().toLowerCase() === activeScreen.toLowerCase(),
			);
			if (matchedActive) {
				return { screen: matchedActive.name.trim() };
			}
		} else {
			return { screen: activeScreen };
		}
	}
	if (cliTargets && cliTargets.screens.length > 0) {
		const primaryScreen = cliTargets.screens.find(
			(scr) => scr.primary && scr.name.trim().length > 0,
		);
		if (primaryScreen) {
			return { screen: primaryScreen.name.trim() };
		}
		const firstScreen = cliTargets.screens[0];
		if (firstScreen && firstScreen.name.trim().length > 0) {
			return { screen: firstScreen.name.trim() };
		}
	}
	if (activeScreen) {
		return { screen: activeScreen };
	}
	throw new Error(
		"Could not determine a target display name. Set a Default Screen Name in Raycast extension preferences or select a display in Cap Desktop.",
	);
}

export function resolveCaptureMode(
	args: StartRecordingArgs,
	preferences: ExtensionPreferences,
	store?: CapDesktopStore | null,
): CaptureMode {
	const argScreen = args.screen?.trim();
	if (argScreen) {
		return { screen: argScreen };
	}
	const prefScreen = preferences.defaultScreen?.trim();
	if (prefScreen) {
		return { screen: prefScreen };
	}
	const effectiveStore = store === undefined ? readCapDesktopStore() : store;
	const cliTargets = queryCapCliTargets();
	const activeScreenName = detectActiveMacScreenName();
	return resolveCaptureModeFromSources({
		args,
		preferences,
		store: effectiveStore ?? null,
		cliTargets,
		activeScreenName,
	});
}

export function buildStartRecordingPayload(
	args: StartRecordingArgs,
	preferences: ExtensionPreferences,
	store?: CapDesktopStore | null,
	captureModeOverride?: CaptureMode,
): StartRecordingPayload {
	const effectiveStore = store === undefined ? readCapDesktopStore() : store;
	const captureMode =
		captureModeOverride ??
		resolveCaptureMode(args, preferences, effectiveStore ?? null);
	return {
		capture_mode: captureMode,
		camera: resolveCameraSelection(preferences, effectiveStore ?? null),
		mic_label: resolveMicLabel(preferences, effectiveStore ?? null),
		capture_system_audio: resolveSystemAudio(
			preferences,
			effectiveStore ?? null,
		),
		mode: resolveRecordingMode(args, preferences, effectiveStore ?? null),
	};
}

export function resolveLocalRecordingsDirs(
	store?: CapDesktopStore | null,
	customRecordingsDir?: string,
): string[] {
	const envDir = process.env.CAP_GPUI_RECORDINGS_DIR?.trim();
	if (envDir) {
		return existsSync(envDir) ? [resolve(envDir)] : [];
	}
	const effectiveStore = store === undefined ? readCapDesktopStore() : store;
	const appDataDir = resolveCapAppDataDir();
	const candidates: string[] = [];
	const customDir = customRecordingsDir?.trim();
	if (customDir) {
		candidates.push(customDir);
	}
	const currentPath = effectiveStore?.general_settings?.recordingsPath?.trim();
	if (currentPath) {
		candidates.push(currentPath);
	}
	candidates.push(join(appDataDir, "recordings"));
	const previousPaths =
		effectiveStore?.general_settings?.previousRecordingsPaths ?? [];
	for (const prev of previousPaths) {
		if (prev.trim()) {
			candidates.push(prev.trim());
		}
	}
	const seen = new Set<string>();
	const validDirs: string[] = [];
	for (const dir of candidates) {
		if (!isAbsolute(dir) || !existsSync(dir)) {
			continue;
		}
		try {
			const stat = statSync(dir);
			if (!stat.isDirectory()) {
				continue;
			}
			const canonical = realpathSync(dir);
			if (!seen.has(canonical)) {
				seen.add(canonical);
				validDirs.push(dir);
			}
		} catch {}
	}
	return validDirs;
}

export function isValidHttpUrl(rawUrl: string): boolean {
	try {
		const parsed = new URL(rawUrl);
		return (
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			!parsed.username &&
			!parsed.password
		);
	} catch {
		return false;
	}
}

export function loadLocalRecordings(
	store?: CapDesktopStore | null,
	customRecordingsDir?: string,
): CapRecordingItem[] {
	const dirs = resolveLocalRecordingsDirs(store, customRecordingsDir);
	const items: Array<{ item: CapRecordingItem; timestampMs: number }> = [];
	for (const dir of dirs) {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const entryName of entries) {
			if (!entryName.endsWith(".cap")) {
				continue;
			}
			const bundlePath = join(dir, entryName);
			const metaPath = join(bundlePath, "recording-meta.json");
			if (!existsSync(metaPath)) {
				continue;
			}
			try {
				const stat = statSync(bundlePath);
				if (!stat.isDirectory()) {
					continue;
				}
				const rawMeta: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
				if (!isRecord(rawMeta)) {
					continue;
				}
				const prettyName =
					typeof rawMeta.pretty_name === "string" &&
					rawMeta.pretty_name.trim().length > 0
						? rawMeta.pretty_name.trim()
						: entryName.replace(/\.cap$/, "");
				const mode: RecordingMode =
					"segments" in rawMeta || "segment" in rawMeta ? "studio" : "instant";
				let shareUrl: string | undefined;
				if (
					isRecord(rawMeta.sharing) &&
					typeof rawMeta.sharing.link === "string"
				) {
					const link = rawMeta.sharing.link.trim();
					if (isValidHttpUrl(link)) {
						shareUrl = link;
					}
				}
				const timestampMs =
					Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
						? stat.birthtimeMs
						: stat.mtimeMs;
				const createdAt = new Date(timestampMs).toISOString();
				items.push({
					timestampMs,
					item: {
						id: bundlePath,
						title: prettyName,
						mode,
						createdAt,
						shareUrl,
						projectPath: bundlePath,
						source: "local",
					},
				});
			} catch {}
		}
	}
	items.sort((a, b) => b.timestampMs - a.timestampMs);
	return items.map((entry) => entry.item);
}

export function resolveApiToken(
	preferences: ExtensionPreferences,
	store?: CapDesktopStore | null,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const prefKey = preferences.apiKey?.trim();
	if (prefKey) {
		return prefKey;
	}
	const agentToken = env.CAP_AGENT_TOKEN?.trim();
	if (agentToken) {
		return agentToken;
	}
	const envKey = env.CAP_API_KEY?.trim();
	if (envKey) {
		return envKey;
	}
	const effectiveStore = store === undefined ? readCapDesktopStore() : store;
	const storeSecret = effectiveStore?.auth?.secret;
	const desktopKey = storeSecret?.api_key?.trim() || storeSecret?.token?.trim();
	return desktopKey || null;
}

export function parseCloudCapsResponse(payload: unknown): CapRecordingItem[] {
	if (
		!isRecord(payload) ||
		!Array.isArray((payload as CloudCapsResponse).caps)
	) {
		return [];
	}
	const rawCaps = (payload as CloudCapsResponse).caps ?? [];
	const results: CapRecordingItem[] = [];
	for (const cap of rawCaps) {
		if (!isRecord(cap) || typeof cap.id !== "string" || !cap.id.trim()) {
			continue;
		}
		const title =
			(typeof cap.title === "string" && cap.title.trim()) ||
			(typeof cap.aiTitle === "string" && cap.aiTitle.trim()) ||
			`Cap ${cap.id}`;
		const rawShareUrl =
			typeof cap.shareUrl === "string" ? cap.shareUrl.trim() : "";
		const shareUrl = isValidHttpUrl(rawShareUrl) ? rawShareUrl : undefined;
		const statusObj = isRecord(cap.status) ? cap.status : undefined;
		const overallStatus =
			statusObj && typeof statusObj.overall === "string"
				? statusObj.overall
				: undefined;
		results.push({
			id: cap.id.trim(),
			title,
			mode: "instant",
			createdAt: typeof cap.createdAt === "string" ? cap.createdAt : undefined,
			updatedAt: typeof cap.updatedAt === "string" ? cap.updatedAt : undefined,
			durationMs: typeof cap.durationMs === "number" ? cap.durationMs : null,
			shareUrl,
			source: "cloud",
			status: overallStatus,
		});
	}
	return results;
}

export async function fetchCloudCaps(
	preferences: ExtensionPreferences,
	searchQuery?: string,
	store?: CapDesktopStore | null,
): Promise<CapRecordingItem[]> {
	const effectiveStore = store === undefined ? readCapDesktopStore() : store;
	const token = resolveApiToken(preferences, effectiveStore);
	if (!token) {
		return [];
	}
	const origin = resolveServerOrigin(preferences, effectiveStore);
	const url = new URL(`${origin}/api/v1/caps`);
	url.searchParams.set("scope", "all");
	url.searchParams.set("limit", "50");
	if (searchQuery?.trim()) {
		url.searchParams.set("search", searchQuery.trim());
	}
	const response = await fetch(url.toString(), {
		method: "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
		},
	});
	if (!response.ok) {
		throw new Error(`Cap server returned HTTP ${response.status}`);
	}
	const json: unknown = await response.json();
	return parseCloudCapsResponse(json);
}

export function mergeRecordings(
	localItems: CapRecordingItem[],
	cloudItems: CapRecordingItem[],
): CapRecordingItem[] {
	const merged: CapRecordingItem[] = [...localItems];
	const byShareUrl = new Map<string, number>();
	for (let i = 0; i < merged.length; i++) {
		const shareUrl = merged[i].shareUrl;
		if (shareUrl) {
			byShareUrl.set(shareUrl, i);
		}
	}
	for (const cloud of cloudItems) {
		if (cloud.shareUrl && byShareUrl.has(cloud.shareUrl)) {
			const idx = byShareUrl.get(cloud.shareUrl);
			if (idx !== undefined) {
				merged[idx] = {
					...cloud,
					mode: merged[idx].mode,
					projectPath: merged[idx].projectPath,
				};
				continue;
			}
		}
		merged.push(cloud);
	}
	return merged;
}

export function formatDuration(durationMs?: number | null): string | null {
	if (
		typeof durationMs !== "number" ||
		!Number.isFinite(durationMs) ||
		durationMs <= 0
	) {
		return null;
	}
	const totalSeconds = Math.round(durationMs / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
