import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	getSettings: vi.fn<() => Promise<Record<string, unknown>>>(),
	setSettings: vi.fn(),
	storageListener: (_event: { key: string; newValue: string }) => {},
}));

vi.mock("solid-js", () => vi.importActual("solid-js/dist/solid.js"));
vi.mock("solid-js/store", () =>
	vi.importActual("solid-js/store/dist/store.js"),
);
vi.mock("@solid-primitives/event-listener", () => ({
	createEventListener: (
		_target: unknown,
		_name: string,
		listener: typeof fixture.storageListener,
	) => {
		fixture.storageListener = listener;
	},
}));
vi.mock("@tanstack/solid-query", () => ({
	queryOptions: (value: unknown) => value,
	createQuery: vi.fn(),
	useQuery: vi.fn(),
	useMutation: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("~/routes/(window-chrome)/OptionsContext", () => ({
	useRecordingOptions: vi.fn(),
}));
vi.mock("~/store", () => ({
	authStore: {},
	generalSettingsStore: {},
	recordingSettingsStore: {
		get: fixture.getSettings,
		set: fixture.setSettings,
		listen: async () => () => {},
	},
}));
vi.mock("./events", () => ({ createQueryInvalidate: vi.fn() }));
vi.mock("./tauri", () => ({ commands: {} }));
vi.mock("./web-api", () => ({
	orgCustomDomainClient: {},
	protectedHeaders: vi.fn(),
}));

import { createOptionsQuery } from "./queries";

const storage = new Map<string, string>();
const disposers: (() => void)[] = [];

beforeEach(() => {
	vi.clearAllMocks();
	storage.clear();
	vi.stubGlobal("window", {});
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.unstubAllGlobals();
});

function loadOptions(cameraID: unknown) {
	storage.set(
		"recording-options-query-2",
		JSON.stringify({
			captureTarget: { variant: "display", id: "0" },
			micName: "Local microphone",
			cameraLabel: null,
			cameraID,
			mode: "studio",
			organizationId: null,
		}),
	);
	let resolveSettings: (settings: Record<string, unknown>) => void = () => {};
	fixture.getSettings.mockReturnValueOnce(
		new Promise((resolve) => {
			resolveSettings = resolve;
		}),
	);
	const options = createRoot((dispose) => {
		disposers.push(dispose);
		return createOptionsQuery();
	});
	return {
		...options,
		async hydrate(cameraId: unknown) {
			resolveSettings({ cameraId, micName: "Saved microphone" });
			await Promise.resolve();
		},
	};
}

describe("camera preference hydration with Solid persistence", () => {
	it.each([
		[{ DeviceID: "camera-a" }, { ModelID: "046d:08e5" }],
		[{ ModelID: "046d:08e5" }, { DeviceID: "camera-b" }],
	])("replaces the previous variant from %j with %j", async (local, saved) => {
		const options = loadOptions(local);
		expect(options.rawOptions.cameraID).toEqual(local);
		await options.hydrate(saved);
		expect(options.rawOptions.cameraID).toEqual(saved);
		expect(Object.keys(options.rawOptions.cameraID ?? {})).toHaveLength(1);
		expect(options.rawOptions.micName).toBe("Saved microphone");
	});

	it.each([
		{ DeviceID: "camera-a", ModelID: "046d:08e5" },
		{ ModelID: "missing-separator" },
		{ DeviceID: 123 },
		{ DeviceID: "" },
		{ unknown: "camera-a" },
		{},
		"camera-a",
	])(
		"preserves a valid local choice when shared camera data is %j",
		async (saved) => {
			const local = { DeviceID: "local-camera" };
			const options = loadOptions(local);
			await options.hydrate(saved);
			expect(options.rawOptions.cameraID).toEqual(local);
			expect(options.rawOptions.micName).toBe("Saved microphone");
		},
	);

	it("clears an ambiguous local choice without choosing either camera", async () => {
		const invalid = { DeviceID: "camera-a", ModelID: "046d:08e5" };
		const options = loadOptions(invalid);
		expect(options.rawOptions.cameraID).toBeNull();
		expect(options.rawOptions.micName).toBe("Local microphone");
		await options.hydrate(invalid);
		expect(options.rawOptions.cameraID).toBeNull();
		expect(
			JSON.parse(storage.get("recording-options-query-2") ?? "{}").cameraID,
		).toBeNull();
	});

	it("restores a valid shared camera after clearing malformed local data", async () => {
		const options = loadOptions({ ModelID: "missing-separator" });
		await options.hydrate({ ModelID: "046d:08e5" });
		expect(options.rawOptions.cameraID).toEqual({ ModelID: "046d:08e5" });
	});

	it("honors an explicit saved None instead of keeping the local camera", async () => {
		const options = loadOptions({ DeviceID: "camera-a" });
		await options.hydrate(null);
		expect(options.rawOptions.cameraID).toBeNull();
	});

	it("does not replace a newer user choice with late hydration", async () => {
		const options = loadOptions({ DeviceID: "camera-a" });
		options.setOptions("cameraID", null);
		await options.hydrate({ ModelID: "046d:08e5" });
		expect(options.rawOptions.cameraID).toBeNull();
	});

	it("replaces variants from another window and rejects ambiguous updates", async () => {
		const options = loadOptions({ DeviceID: "camera-a" });
		fixture.storageListener({
			key: "recording-options-query-2",
			newValue: JSON.stringify({ cameraID: { ModelID: "046d:08e5" } }),
		});
		expect(options.rawOptions.cameraID).toEqual({ ModelID: "046d:08e5" });
		fixture.storageListener({
			key: "recording-options-query-2",
			newValue: JSON.stringify({
				cameraID: { DeviceID: "camera-b", ModelID: "046d:08e5" },
			}),
		});
		await options.hydrate({ DeviceID: "older-choice" });
		expect(options.rawOptions.cameraID).toBeNull();
	});
});
