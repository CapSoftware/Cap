// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PREFERRED_MICROPHONE_KEY,
	REMEMBER_DEVICES_KEY,
	useDevicePreferences,
} from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useDevicePreferences";

type Mic = { deviceId: string };
type Prefs = ReturnType<typeof useDevicePreferences>;

const globals = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: Prefs | null = null;
let storage = new Map<string, string>();

const stubStorage = () => {
	storage = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
};

const Harness = ({ mics }: { mics: Mic[] }) => {
	latest = useDevicePreferences({
		open: true,
		availableCameras: [],
		availableMics: mics,
	});
	return null;
};

const render = async (mics: Mic[]) => {
	if (!container) {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	}
	await act(async () => {
		root?.render(createElement(Harness, { mics }));
	});
};

const prefs = () => {
	if (!latest) throw new Error("hook not rendered");
	return latest;
};

const usb = { deviceId: "usb-mic" };
const builtIn = { deviceId: "built-in-mic" };
const systemDefault = { deviceId: "default" };

describe("web recorder microphone auto-select", () => {
	beforeEach(() => {
		globals.IS_REACT_ACT_ENVIRONMENT = true;
		stubStorage();
	});

	afterEach(async () => {
		await act(async () => {
			root?.unmount();
		});
		container?.remove();
		root = null;
		container = null;
		latest = null;
		vi.unstubAllGlobals();
	});

	it("selects the default mic once the list fills after a permission grant", async () => {
		await render([]);
		expect(prefs().selectedMicId).toBeNull();

		await render([usb, systemDefault, builtIn]);
		expect(prefs().selectedMicId).toBe("default");
	});

	it("falls back to the first mic when there is no default device", async () => {
		await render([usb, builtIn]);
		expect(prefs().selectedMicId).toBe("usb-mic");
	});

	it("keeps an explicit No Microphone choice", async () => {
		await render([systemDefault, usb]);
		expect(prefs().selectedMicId).toBe("default");

		await act(async () => {
			prefs().handleMicChange(null);
		});
		expect(prefs().selectedMicId).toBeNull();

		await render([systemDefault, usb, builtIn]);
		await render([]);
		await render([systemDefault, usb]);
		expect(prefs().selectedMicId).toBeNull();

		await act(async () => {
			prefs().handleMicChange("usb-mic");
		});
		expect(prefs().selectedMicId).toBe("usb-mic");
	});

	it("prefers the remembered mic over the default", async () => {
		storage.set(REMEMBER_DEVICES_KEY, "true");
		storage.set(PREFERRED_MICROPHONE_KEY, "built-in-mic");

		await render([]);
		await render([systemDefault, usb, builtIn]);
		expect(prefs().selectedMicId).toBe("built-in-mic");
	});

	it("ignores a remembered mic that is no longer connected", async () => {
		storage.set(REMEMBER_DEVICES_KEY, "true");
		storage.set(PREFERRED_MICROPHONE_KEY, "unplugged-mic");

		await render([usb, systemDefault]);
		expect(prefs().selectedMicId).toBe("default");
	});
});
