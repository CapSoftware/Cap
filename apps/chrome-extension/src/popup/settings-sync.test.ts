// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_KEY, defaultSettings, SETTINGS_KEY } from "../shared/storage";
import type { ExtensionSettings } from "../shared/types";

vi.mock("react-dom/client", async (importOriginal) => {
	const actual = await importOriginal<{ createRoot: typeof createRoot }>();
	return { createRoot: vi.fn(actual.createRoot) };
});

type StorageListener = (
	changes: Record<string, chrome.storage.StorageChange>,
	areaName: string,
) => void;

let stored: Record<string, unknown>;
let storageListeners: Set<StorageListener>;

const storedSettings = () => stored[SETTINGS_KEY] as ExtensionSettings;

const writeSettingsFromAnotherPage = (settings: ExtensionSettings) => {
	stored[SETTINGS_KEY] = settings;
	for (const listener of storageListeners) {
		listener({ [SETTINGS_KEY]: { newValue: settings } }, "local");
	}
};

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	storageListeners = new Set();
	stored = {
		[AUTH_KEY]: { userId: "user-1", authApiKey: "fixture-key" },
		[SETTINGS_KEY]: {
			...defaultSettings,
			microphone: { enabled: true, deviceId: null },
			systemAudio: { enabled: true },
		},
	};
	vi.stubGlobal("chrome", {
		storage: {
			local: {
				get: (keys: string[], callback: (items: object) => void) => {
					callback(
						Object.fromEntries(
							keys
								.filter((key) => key in stored)
								.map((key) => [key, stored[key]]),
						),
					);
				},
				set: (items: Record<string, unknown>, callback: () => void) => {
					Object.assign(stored, items);
					callback();
				},
			},
			onChanged: {
				addListener: (listener: StorageListener) =>
					storageListeners.add(listener),
				removeListener: (listener: StorageListener) =>
					storageListeners.delete(listener),
			},
		},
		runtime: {
			sendMessage: (
				message: { type: string },
				callback: (response: object) => void,
			) => {
				callback(
					message.type === "bootstrap"
						? { ok: false, error: "Network unavailable" }
						: { ok: true, cameraDevices: [], microphoneDevices: [] },
				);
			},
			onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
		},
	});
	document.body.innerHTML = '<div id="root"></div>';
});

afterEach(async () => {
	const root = vi.mocked(createRoot).mock.results[0]?.value;
	if (root) await act(async () => root.unmount());
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

describe("popup settings sync", () => {
	it("keeps a mic mute made outside the panel when the panel saves another setting", async () => {
		await act(async () => {
			await import("./main");
		});

		await act(async () => {
			writeSettingsFromAnotherPage({
				...storedSettings(),
				microphone: { enabled: false, deviceId: null },
			});
		});

		const systemAudio = [...document.querySelectorAll("button")].find(
			(button) => button.textContent?.includes("System Audio"),
		);
		await act(async () => systemAudio?.click());

		expect(storedSettings().systemAudio.enabled).toBe(false);
		expect(storedSettings().microphone.enabled).toBe(false);
	}, 15_000);
});
