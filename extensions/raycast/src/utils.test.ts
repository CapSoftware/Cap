import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CapDesktopStore } from "./types";
import {
	buildOpenEditorUrl,
	buildOpenSettingsUrl,
	buildStartRecordingPayload,
	buildStartRecordingUrl,
	buildStopRecordingUrl,
	formatDuration,
	isValidHttpUrl,
	loadLocalRecordings,
	mergeRecordings,
	normalizeServerOrigin,
	parseCapCliTargetsJson,
	parseCloudCapsResponse,
	parseStoredCameraId,
	parseStoredTarget,
	parseSystemProfilerDisplays,
	readCapDesktopStore,
	resolveApiToken,
	resolveCameraSelection,
	resolveCapAppDataDir,
	resolveCapStorePath,
	resolveCaptureModeFromSources,
	resolveDashboardUrl,
	resolveMicLabel,
	resolveRecordingMode,
	resolveServerOrigin,
	resolveSystemAudio,
} from "./utils";

describe("deep link builders", () => {
	it("builds start_recording deep link matching Cap Desktop grammar", () => {
		const url = buildStartRecordingUrl({
			capture_mode: { screen: "Odyssey G93SC" },
			camera: { DeviceID: "camera-1" },
			mic_label: "Shure MV7+",
			capture_system_audio: true,
			mode: "studio",
		});

		expect(url.startsWith("cap-desktop://action?value=")).toBe(true);
		const parsedUrl = new URL(url);
		expect(parsedUrl.protocol).toBe("cap-desktop:");
		expect(parsedUrl.host).toBe("action");

		const rawValue = parsedUrl.searchParams.get("value");
		expect(rawValue).not.toBeNull();
		expect(JSON.parse(rawValue as string)).toEqual({
			start_recording: {
				capture_mode: { screen: "Odyssey G93SC" },
				camera: { DeviceID: "camera-1" },
				mic_label: "Shure MV7+",
				capture_system_audio: true,
				mode: "studio",
			},
		});
	});

	it("builds stop_recording deep link for both cap-desktop and cap schemes", () => {
		expect(buildStopRecordingUrl("cap-desktop")).toBe(
			"cap-desktop://action?value=%22stop_recording%22",
		);
		expect(buildStopRecordingUrl("cap")).toBe(
			"cap://action?value=%22stop_recording%22",
		);
	});

	it("builds open_editor and open_settings deep links", () => {
		const editorUrl = new URL(buildOpenEditorUrl("/tmp/My Recording.cap"));
		expect(JSON.parse(editorUrl.searchParams.get("value") as string)).toEqual({
			open_editor: { project_path: "/tmp/My Recording.cap" },
		});

		const settingsUrl = new URL(buildOpenSettingsUrl(null));
		expect(JSON.parse(settingsUrl.searchParams.get("value") as string)).toEqual(
			{
				open_settings: { page: null },
			},
		);
	});
});

describe("Cap Desktop store reading and user defaults preservation", () => {
	it("resolves OS-specific app data and store paths", () => {
		expect(resolveCapAppDataDir("darwin", "/Users/alice", {})).toBe(
			join("/Users/alice", "Library", "Application Support", "so.cap.desktop"),
		);
		expect(resolveCapStorePath("darwin", "/Users/alice", {})).toBe(
			join(
				"/Users/alice",
				"Library",
				"Application Support",
				"so.cap.desktop",
				"store",
			),
		);
		expect(
			resolveCapStorePath("darwin", "/Users/alice", {
				CAP_GPUI_TAURI_STORE: "/custom/store-file",
			}),
		).toBe("/custom/store-file");
	});

	it("parses stored cameraId and target shapes accurately", () => {
		expect(parseStoredCameraId({ DeviceID: "cam-123" })).toEqual({
			DeviceID: "cam-123",
		});
		expect(parseStoredCameraId({ ModelID: "vendor:product" })).toEqual({
			ModelID: "vendor:product",
		});
		expect(parseStoredCameraId({ DeviceID: "a", ModelID: "b" })).toBeNull();
		expect(parseStoredCameraId(null)).toBeNull();

		expect(parseStoredTarget({ variant: "window", id: 42 })).toEqual({
			variant: "window",
			id: 42,
		});
		expect(parseStoredTarget({ variant: "display", id: "1" })).toEqual({
			variant: "display",
			id: "1",
		});
		expect(parseStoredTarget({ variant: "area", screen: 7 })).toEqual({
			variant: "area",
			screen: 7,
			bounds: undefined,
		});
		expect(parseStoredTarget({ variant: "unknown" })).toBeNull();
	});

	it("reads recording_settings, general_settings, and auth from disk store", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "cap-raycast-store-"));
		try {
			const storeFile = join(tempDir, "store");
			writeFileSync(
				storeFile,
				JSON.stringify({
					general_settings: {
						serverUrl: "https://cap.internal.example",
						recordingsPath: "/Users/alice/Recordings",
						previousRecordingsPaths: ["/Users/alice/OldRecordings"],
					},
					recording_settings: {
						mode: "studio",
						cameraId: { ModelID: "vendor:cam" },
						micName: "Shure MV7+",
						systemAudio: true,
						target: { variant: "display", id: 10 },
					},
					auth: {
						secret: {
							api_key: "cap_cli_secret",
						},
					},
				}),
			);

			const loaded = readCapDesktopStore(storeFile);
			expect(loaded).not.toBeNull();
			expect(loaded?.general_settings?.serverUrl).toBe(
				"https://cap.internal.example",
			);
			expect(loaded?.recording_settings?.mode).toBe("studio");
			expect(loaded?.recording_settings?.cameraId).toEqual({
				ModelID: "vendor:cam",
			});
			expect(loaded?.recording_settings?.micName).toBe("Shure MV7+");
			expect(loaded?.recording_settings?.systemAudio).toBe(true);
			expect(loaded?.recording_settings?.target).toEqual({
				variant: "display",
				id: 10,
			});
			expect(loaded?.auth?.secret?.api_key).toBe("cap_cli_secret");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves user camera, mic, system audio, and mode from store when preferences are not overridden", () => {
		const store: CapDesktopStore = {
			recording_settings: {
				mode: "studio",
				cameraId: { DeviceID: "saved-cam-1" },
				micName: "MacBook Pro Microphone",
				systemAudio: true,
			},
		};

		expect(resolveCameraSelection({}, store)).toEqual({
			DeviceID: "saved-cam-1",
		});
		expect(
			resolveCameraSelection({ cameraDeviceId: "override-cam" }, store),
		).toEqual({
			DeviceID: "override-cam",
		});

		expect(resolveMicLabel({}, store)).toBe("MacBook Pro Microphone");
		expect(resolveMicLabel({ micLabel: "External USB Mic" }, store)).toBe(
			"External USB Mic",
		);

		expect(resolveSystemAudio({ systemAudio: "default" }, store)).toBe(true);
		expect(resolveSystemAudio({ systemAudio: "disabled" }, store)).toBe(false);
		expect(resolveSystemAudio({ systemAudio: "enabled" }, null)).toBe(true);

		expect(
			resolveRecordingMode(
				{ mode: "default" },
				{ defaultMode: "default" },
				store,
			),
		).toBe("studio");
		expect(
			resolveRecordingMode(
				{ mode: "instant" },
				{ defaultMode: "studio" },
				store,
			),
		).toBe("instant");

		const payload = buildStartRecordingPayload({}, {}, store, {
			screen: "Built-in Retina Display",
		});
		expect(payload).toEqual({
			capture_mode: { screen: "Built-in Retina Display" },
			camera: { DeviceID: "saved-cam-1" },
			mic_label: "MacBook Pro Microphone",
			capture_system_audio: true,
			mode: "studio",
		});
	});
});

describe("target display and window resolution", () => {
	const sampleCliTargets = parseCapCliTargetsJson(
		JSON.stringify({
			screens: [
				{ index: 0, id: 100, name: "Built-in Retina Display", primary: true },
				{ index: 1, id: 200, name: "DELL U2723QE", primary: false },
			],
			windows: [
				{ index: 0, id: 555, name: "Cap — Raycast", ownerName: "Cursor" },
			],
		}),
	);

	it("prioritizes explicit command argument and preference screen overrides", () => {
		expect(
			resolveCaptureModeFromSources({
				args: { screen: "Arg Display" },
				preferences: { defaultScreen: "Pref Display" },
				store: null,
				cliTargets: sampleCliTargets,
				activeScreenName: "DELL U2723QE",
			}),
		).toEqual({ screen: "Arg Display" });

		expect(
			resolveCaptureModeFromSources({
				args: {},
				preferences: { defaultScreen: "Pref Display" },
				store: null,
				cliTargets: sampleCliTargets,
				activeScreenName: "DELL U2723QE",
			}),
		).toEqual({ screen: "Pref Display" });
	});

	it("resolves saved window or display target from Cap Desktop store via Cap CLI targets", () => {
		expect(
			resolveCaptureModeFromSources({
				args: {},
				preferences: {},
				store: {
					recording_settings: {
						target: { variant: "window", id: 555 },
					},
				},
				cliTargets: sampleCliTargets,
				activeScreenName: "Built-in Retina Display",
			}),
		).toEqual({ window: "Cap — Raycast" });

		expect(
			resolveCaptureModeFromSources({
				args: {},
				preferences: {},
				store: {
					recording_settings: {
						target: { variant: "display", id: 200 },
					},
				},
				cliTargets: sampleCliTargets,
				activeScreenName: "Built-in Retina Display",
			}),
		).toEqual({ screen: "DELL U2723QE" });
	});

	it("falls back to active cursor screen and then primary CLI screen", () => {
		expect(
			resolveCaptureModeFromSources({
				args: {},
				preferences: {},
				store: null,
				cliTargets: sampleCliTargets,
				activeScreenName: "DELL U2723QE",
			}),
		).toEqual({ screen: "DELL U2723QE" });

		expect(
			resolveCaptureModeFromSources({
				args: {},
				preferences: {},
				store: null,
				cliTargets: sampleCliTargets,
				activeScreenName: null,
			}),
		).toEqual({ screen: "Built-in Retina Display" });
	});

	it("parses system_profiler display names and throws when no real target can be resolved", () => {
		const profilerJson = JSON.stringify({
			SPDisplaysDataType: [
				{
					spdisplays_ndrvs: [{ _name: "Studio Display" }],
				},
			],
		});
		expect(parseSystemProfilerDisplays(profilerJson)).toEqual([
			"Studio Display",
		]);

		expect(() =>
			resolveCaptureModeFromSources({
				args: {},
				preferences: {},
				store: null,
				cliTargets: null,
				activeScreenName: null,
			}),
		).toThrow(/Could not determine a target display name/);
	});
});

describe("server origin and dashboard URL normalization", () => {
	it("normalizes pasted dashboard URLs with paths or query params to origin", () => {
		expect(normalizeServerOrigin("https://cap.so/dashboard?tab=caps#top")).toBe(
			"https://cap.so",
		);
		expect(
			normalizeServerOrigin("https://cap.example.com:8443/custom/path/"),
		).toBe("https://cap.example.com:8443");
		expect(
			resolveDashboardUrl(
				{ serverUrl: "https://cap.example.com/dashboard?foo=bar" },
				null,
			),
		).toBe("https://cap.example.com/dashboard");
	});

	it("falls back to Cap Desktop store serverUrl and then default https://cap.so", () => {
		const store: CapDesktopStore = {
			general_settings: {
				serverUrl: "https://selfhosted.cap.internal/app",
			},
		};
		expect(resolveServerOrigin({}, store)).toBe(
			"https://selfhosted.cap.internal",
		);
		expect(resolveDashboardUrl({}, store)).toBe(
			"https://selfhosted.cap.internal/dashboard",
		);
		expect(resolveDashboardUrl({}, null)).toBe("https://cap.so/dashboard");
	});

	it("rejects non-HTTP protocols and embedded credentials", () => {
		expect(() => normalizeServerOrigin("javascript:alert(1)")).toThrow(
			/Unsupported protocol/,
		);
		expect(() => normalizeServerOrigin("file:///etc/passwd")).toThrow(
			/Unsupported protocol/,
		);
		expect(() => normalizeServerOrigin("https://user:pass@cap.so")).toThrow(
			/must not include embedded credentials/,
		);
		expect(isValidHttpUrl("https://cap.so/s/abc123")).toBe(true);
		expect(isValidHttpUrl("https://user:pass@cap.so/s/abc123")).toBe(false);
		expect(isValidHttpUrl("javascript:alert(1)")).toBe(false);
	});
});

describe("local and cloud recordings discovery", () => {
	it("discovers local .cap bundles and parses recording-meta.json", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "cap-raycast-recordings-"));
		try {
			const studioBundle = join(tempRoot, "demo-studio.cap");
			mkdirSync(studioBundle, { recursive: true });
			writeFileSync(
				join(studioBundle, "recording-meta.json"),
				JSON.stringify({
					pretty_name: "Architecture Walkthrough",
					segments: [],
					sharing: {
						id: "share-1",
						link: "https://cap.so/s/share-1",
					},
				}),
			);

			const instantBundle = join(tempRoot, "quick-clip.cap");
			mkdirSync(instantBundle, { recursive: true });
			writeFileSync(
				join(instantBundle, "recording-meta.json"),
				JSON.stringify({
					pretty_name: "Quick Bug Repro",
				}),
			);

			const store: CapDesktopStore = {
				general_settings: {
					recordingsPath: tempRoot,
				},
			};

			const recordings = loadLocalRecordings(store);
			expect(recordings.length).toBe(2);
			const studio = recordings.find(
				(r) => r.title === "Architecture Walkthrough",
			);
			const instant = recordings.find((r) => r.title === "Quick Bug Repro");
			expect(studio?.mode).toBe("studio");
			expect(studio?.shareUrl).toBe("https://cap.so/s/share-1");
			expect(studio?.projectPath).toBe(studioBundle);
			expect(instant?.mode).toBe("instant");
			expect(instant?.shareUrl).toBeUndefined();
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("parses cloud caps API response, merges with local recordings, and formats durations", () => {
		const cloudItems = parseCloudCapsResponse({
			caps: [
				{
					id: "cap_123",
					title: "Architecture Walkthrough",
					shareUrl: "https://cap.so/s/share-1",
					durationMs: 125000,
					createdAt: "2026-04-01T10:00:00.000Z",
				},
				{
					id: "cap_456",
					title: null,
					aiTitle: "Sprint Demo",
					shareUrl: "https://cap.so/s/share-2",
					durationMs: 45000,
				},
			],
		});

		expect(cloudItems).toHaveLength(2);
		expect(cloudItems[1].title).toBe("Sprint Demo");

		const merged = mergeRecordings(
			[
				{
					id: "/local/demo-studio.cap",
					title: "Architecture Walkthrough",
					mode: "studio",
					shareUrl: "https://cap.so/s/share-1",
					projectPath: "/local/demo-studio.cap",
					source: "local",
				},
			],
			cloudItems,
		);

		expect(merged).toHaveLength(2);
		expect(merged[0].projectPath).toBe("/local/demo-studio.cap");
		expect(merged[0].mode).toBe("studio");
		expect(merged[0].durationMs).toBe(125000);
		expect(formatDuration(125000)).toBe("2:05");
		expect(formatDuration(45000)).toBe("0:45");
		expect(formatDuration(null)).toBeNull();
	});

	it("resolves API token in priority order", () => {
		const store: CapDesktopStore = {
			auth: {
				secret: {
					api_key: "store_key",
				},
			},
		};
		expect(
			resolveApiToken({ apiKey: "pref_key" }, store, {
				CAP_AGENT_TOKEN: "env_agent",
			}),
		).toBe("pref_key");
		expect(
			resolveApiToken({}, store, {
				CAP_AGENT_TOKEN: "env_agent",
				CAP_API_KEY: "env_api",
			}),
		).toBe("env_agent");
		expect(resolveApiToken({}, store, { CAP_API_KEY: "env_api" })).toBe(
			"env_api",
		);
		expect(resolveApiToken({}, store, {})).toBe("store_key");
	});
});
