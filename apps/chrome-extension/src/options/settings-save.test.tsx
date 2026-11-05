// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, SETTINGS_KEY } from "../shared/storage";
import type { ExtensionSettings } from "../shared/types";

vi.mock("react-dom/client", async (importOriginal) => {
	const actual = await importOriginal<{ createRoot: typeof createRoot }>();
	return { createRoot: vi.fn(actual.createRoot) };
});

vi.mock("../shared/page-nav", () => ({ mountPageNav: vi.fn() }));
vi.mock("@cap/recorder-core", () => ({
	deleteRecoveredRecordingSpool: vi.fn(),
	recoverOrphanedRecordingSpools: async () => [],
}));

let stored: Record<string, unknown>;
let rejectWrite: boolean;
let holdWrite: boolean;
let pendingWrites: Array<() => void>;
let messages: Array<{ type: string; settings?: ExtensionSettings }>;

const storedSettings = () => stored[SETTINGS_KEY] as ExtensionSettings;

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	rejectWrite = false;
	holdWrite = false;
	pendingWrites = [];
	messages = [];
	stored = { [SETTINGS_KEY]: structuredClone(defaultSettings) };
	vi.stubGlobal("chrome", {
		storage: {
			local: {
				get: (keys: string[], callback: (items: object) => void) =>
					callback(
						Object.fromEntries(
							keys
								.filter((key) => key in stored)
								.map((key) => [key, stored[key]]),
						),
					),
				set: (items: object, callback: () => void) => {
					if (rejectWrite) throw new Error("Storage unavailable");
					const write = () => {
						Object.assign(stored, items);
						callback();
					};
					if (holdWrite) pendingWrites.push(write);
					else write();
				},
			},
			onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
		},
		runtime: {
			sendMessage: (
				message: { type: string; settings?: ExtensionSettings },
				callback: (response: object) => void,
			) => {
				messages.push(message);
				callback({ ok: true });
			},
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

const openOptions = async () => {
	await act(async () => {
		await import("./main");
	});
};

const clickButton = async (text: string) => {
	const button = [...document.querySelectorAll("button")].find(
		(item) => item.textContent === text,
	);
	if (!button) throw new Error(`Missing button: ${text}`);
	await act(async () => button.click());
};

const toggleCheckbox = async (label: string) => {
	const checkbox = [...document.querySelectorAll("label")]
		.find((item) => item.textContent?.includes(label))
		?.querySelector("input");
	if (!checkbox) throw new Error(`Missing checkbox: ${label}`);
	await act(async () => checkbox.click());
};

describe("options saves", () => {
	it("preserves recorder changes made while an options draft is open", async () => {
		await openOptions();
		await toggleCheckbox("Show countdown before recording");
		const latest: ExtensionSettings = {
			...storedSettings(),
			capture: { ...defaultSettings.capture, recordingMode: "tab" },
			webcam: {
				...defaultSettings.webcam,
				enabled: true,
				deviceId: "camera-2",
				size: 350,
			},
			microphone: { enabled: false, deviceId: "mic-2" },
			systemAudio: { enabled: false },
			countdown: { enabled: true, seconds: 10 },
		};
		stored[SETTINGS_KEY] = latest;

		await clickButton("Save changes");

		const expected = { ...latest, countdown: { enabled: false, seconds: 10 } };
		expect(storedSettings()).toEqual(expected);
		expect(messages).toContainEqual({
			target: "service-worker",
			type: "settings-updated",
			settings: expected,
		});
	});

	it("saves an edited mic toggle without restoring the old device", async () => {
		await openOptions();
		await toggleCheckbox("Enable microphone by default");
		stored[SETTINGS_KEY] = {
			...storedSettings(),
			microphone: { enabled: true, deviceId: "mic-2" },
		};

		await clickButton("Save changes");
		expect(storedSettings().microphone).toEqual({
			enabled: false,
			deviceId: "mic-2",
		});

		stored[SETTINGS_KEY] = {
			...storedSettings(),
			microphone: { enabled: true, deviceId: "mic-3" },
		};
		await clickButton("Save changes");
		expect(storedSettings().microphone).toEqual({
			enabled: true,
			deviceId: "mic-3",
		});
	});

	it("keeps the draft after a failed save so it can be retried", async () => {
		await openOptions();
		await toggleCheckbox("Show countdown before recording");
		rejectWrite = true;
		await clickButton("Save changes");
		expect(document.body.textContent).toContain("Storage unavailable");

		rejectWrite = false;
		await clickButton("Save changes");
		expect(storedSettings().countdown.enabled).toBe(false);
	});

	it("locks the draft while its save is pending", async () => {
		await openOptions();
		await toggleCheckbox("Show countdown before recording");
		holdWrite = true;
		await clickButton("Save changes");

		expect(pendingWrites).toHaveLength(1);
		for (const input of document.querySelectorAll("input, select")) {
			expect(input.hasAttribute("disabled")).toBe(true);
		}
		await clickButton("Save changes");
		expect(pendingWrites).toHaveLength(1);

		await act(async () => pendingWrites.shift()?.());
		expect(storedSettings().countdown.enabled).toBe(false);
		expect(document.body.textContent).toContain("Saved");
		expect(
			document.querySelector('input[type="url"]')?.hasAttribute("disabled"),
		).toBe(false);
	});
});
