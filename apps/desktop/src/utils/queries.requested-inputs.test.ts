import { readFileSync } from "node:fs";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	options: {
		micName: null as string | null,
		cameraID: null as { DeviceID: string } | null,
	},
	setMicInput: vi.fn(async (_name: string | null) => {}),
	setCameraInput: vi.fn(
		async (_id: { DeviceID: string } | null, _skip: boolean | null) => {},
	),
	setFocus: vi.fn(async () => {}),
	getSettings:
		vi.fn<
			() => Promise<{
				micName: string | null;
				cameraId: { DeviceID: string } | null;
			}>
		>(),
}));

vi.mock("@tanstack/solid-query", () => ({
	queryOptions: (value: unknown) => value,
	createQuery: vi.fn(),
	useQuery: vi.fn(),
	useMutation: (
		factory: () => { mutationFn: (value: unknown) => unknown },
	) => ({
		mutateAsync: factory().mutationFn,
	}),
}));
vi.mock("@solid-primitives/event-listener", () => ({
	createEventListener: vi.fn(),
}));
vi.mock("@solid-primitives/storage", () => ({
	makePersisted: (store: unknown) => store,
}));
vi.mock("solid-js", () => ({
	batch: (action: () => void) => action(),
	createEffect: vi.fn(),
	createMemo: vi.fn(),
	onCleanup: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ setFocus: fixture.setFocus }),
}));
vi.mock("solid-js/store", () => ({
	createStore: (initial: Record<string, unknown>) => [
		initial,
		(key: string | object, value: unknown) => {
			if (typeof key === "string") initial[key] = value;
			else Object.assign(initial, key);
		},
	],
	reconcile: (value: unknown) => value,
}));
vi.mock("~/routes/(window-chrome)/OptionsContext", () => ({
	useRecordingOptions: () => ({
		rawOptions: fixture.options,
		setOptions: (
			key: "micName" | "cameraID",
			value: string | { DeviceID: string } | null,
		) => {
			if (key === "micName" && (typeof value === "string" || value === null)) {
				fixture.options.micName = value;
			} else if (key === "cameraID" && typeof value !== "string") {
				fixture.options.cameraID = value;
			}
		},
	}),
}));
vi.mock("~/store", () => ({
	authStore: {},
	generalSettingsStore: {},
	recordingSettingsStore: {
		get: fixture.getSettings,
		set: vi.fn(),
		listen: vi.fn(async () => () => {}),
	},
}));
vi.mock("./events", () => ({ createQueryInvalidate: vi.fn() }));
vi.mock("./tauri", () => ({
	commands: {
		setMicInput: fixture.setMicInput,
		setCameraInput: fixture.setCameraInput,
	},
}));
vi.mock("./web-api", () => ({
	orgCustomDomainClient: {},
	protectedHeaders: vi.fn(),
}));

import {
	createCameraMutation,
	createMicrophoneMutation,
	createOptionsQuery,
} from "./queries";

beforeEach(() => {
	vi.resetAllMocks();
	fixture.options.micName = null;
	fixture.options.cameraID = null;
	fixture.setMicInput.mockResolvedValue(undefined);
	fixture.setCameraInput.mockResolvedValue(undefined);
});

describe("requested microphone intent", () => {
	it("keeps a failed A to B request instead of rolling back to A", async () => {
		fixture.options.micName = "A";
		fixture.setMicInput.mockRejectedValueOnce(new Error("Cannot open B"));
		await expect(createMicrophoneMutation().mutateAsync("B")).rejects.toThrow(
			"Cannot open B",
		);
		expect(fixture.options.micName).toBe("B");
	});

	it("does not let an older failed request replace a later None", async () => {
		let rejectOld: (error: Error) => void = () => {};
		fixture.setMicInput.mockImplementationOnce(
			() =>
				new Promise<void>((_, reject) => {
					rejectOld = reject;
				}),
		);
		const mutation = createMicrophoneMutation();
		const old = mutation.mutateAsync("A");
		await mutation.mutateAsync(null);
		rejectOld(new Error("A failed late"));
		await old;
		expect(fixture.options.micName).toBeNull();
	});

	it("ignores superseded duplicate setup without erasing selection", async () => {
		fixture.setMicInput.mockRejectedValueOnce(
			"Microphone selection was superseded by a newer request",
		);
		await createMicrophoneMutation().mutateAsync("A");
		expect(fixture.options.micName).toBe("A");
	});
});

describe("requested camera intent", () => {
	it("retains a persisted selection after initialization failure", async () => {
		fixture.options.cameraID = { DeviceID: "A" };
		fixture.setCameraInput.mockRejectedValueOnce(
			new Error("Failed to initialize camera"),
		);
		await expect(
			createCameraMutation().mutateAsync({ model: { DeviceID: "A" } }),
		).rejects.toThrow("Failed to initialize camera");
		expect(fixture.options.cameraID).toEqual({ DeviceID: "A" });
	});

	it("keeps a failed new camera request rather than the old camera", async () => {
		fixture.options.cameraID = { DeviceID: "A" };
		fixture.setCameraInput.mockRejectedValueOnce(new Error("DeviceNotFound"));
		await expect(
			createCameraMutation().mutateAsync({ model: { DeviceID: "B" } }),
		).rejects.toThrow("DeviceNotFound");
		expect(fixture.options.cameraID).toEqual({ DeviceID: "B" });
	});

	it("does not focus or overwrite a newer request when old setup completes", async () => {
		let finishOld: () => void = () => {};
		fixture.setCameraInput.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishOld = resolve;
				}),
		);
		const mutation = createCameraMutation();
		const old = mutation.mutateAsync({ model: { DeviceID: "A" } });
		await mutation.mutateAsync({ model: null });
		finishOld();
		await old;
		expect(fixture.options.cameraID).toBeNull();
		expect(fixture.setFocus).not.toHaveBeenCalled();
	});
});

describe("initial requested input hydration", () => {
	it("does not overwrite rapid A/B/None choices with an older persisted result", async () => {
		vi.stubGlobal("window", {});
		let finish: (settings: {
			micName: string | null;
			cameraId: { DeviceID: string } | null;
		}) => void = () => {};
		fixture.getSettings.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const options = createOptionsQuery();
		options.setOptions("micName", "A");
		options.setOptions("micName", "B");
		options.setOptions("micName", null);
		options.setOptions("cameraID", { DeviceID: "B" });
		options.setOptions("cameraID", null);
		finish({ micName: "Persisted A", cameraId: { DeviceID: "A" } });
		await Promise.resolve();
		expect(options.rawOptions.micName).toBeNull();
		expect(options.rawOptions.cameraID).toBeNull();
		vi.unstubAllGlobals();
	});

	it("still hydrates the input that the user has not changed", async () => {
		vi.stubGlobal("window", {});
		fixture.getSettings.mockResolvedValueOnce({
			micName: "Persisted mic",
			cameraId: { DeviceID: "Persisted camera" },
		});
		const options = createOptionsQuery();
		options.setOptions("micName", null);
		await Promise.resolve();
		expect(options.rawOptions.micName).toBeNull();
		expect(options.rawOptions.cameraID).toEqual({
			DeviceID: "Persisted camera",
		});
		vi.unstubAllGlobals();
	});
});

type PausedCamera = {
	device_id: string;
	model_id: string | null;
	display_name: string;
};
type PausedCameraId = { DeviceID: string } | { ModelID: string } | null;
type PausedOptions = { micName: string | null; cameraID: PausedCameraId };
type PausedMutations = {
	updateMicInput: { mutateAsync(name: string | null): Promise<void> };
	updateCameraInput: {
		mutateAsync(camera: PausedCamera | null): Promise<void>;
	};
};

const pausedRoute = ts.createSourceFile(
	"in-progress-recording.tsx",
	readFileSync(
		new URL("../routes/in-progress-recording.tsx", import.meta.url),
		"utf8",
	),
	ts.ScriptTarget.ESNext,
	true,
	ts.ScriptKind.TSX,
);
const pausedComponent = pausedRoute.statements.find(
	(statement): statement is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(statement) &&
		statement.name?.text === "InProgressRecordingInner",
);
const pausedMutationNames = new Set([
	"pauseRecordingForDeviceChange",
	"updateMicInput",
	"updateCameraInput",
]);
const pausedStatements = pausedComponent?.body?.statements.filter(
	(statement) =>
		ts.isVariableStatement(statement) &&
		statement.declarationList.declarations.some(
			(declaration) =>
				ts.isIdentifier(declaration.name) &&
				pausedMutationNames.has(declaration.name.text),
		),
);
if (pausedStatements?.length !== 3) {
	throw new Error("Paused device mutation source was not found");
}
const pausedHelpers = pausedRoute.statements.filter(
	(statement) =>
		ts.isFunctionDeclaration(statement) &&
		[
			"cameraInfoToId",
			"cameraMatchesSelection",
			"cloneDeviceOrModelId",
		].includes(statement.name?.text ?? ""),
);
const pausedMutationCode = ts.transpileModule(
	[...pausedStatements, ...pausedHelpers]
		.map((statement) => statement.getText(pausedRoute))
		.join("\n"),
	{ compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const createPausedMutations = new Function(
	"createMutation",
	"optionsQuery",
	"commands",
	"state",
	"startedWithMicrophone",
	"startedWithCameraInput",
	"cameraWindowOpen",
	"getCameraWindow",
	"refreshCameraWindowState",
	"reconcile",
	`${pausedMutationCode}\nreturn { updateMicInput, updateCameraInput };`,
) as (...args: unknown[]) => PausedMutations;

const pausedStore =
	await vi.importActual<typeof import("solid-js/store")>("solid-js/store");

function pausedControls() {
	const [options, setOptions] = pausedStore.createStore<PausedOptions>({
		micName: "A",
		cameraID: { DeviceID: "A" },
	});
	const state = { variant: "paused" };
	const commands = {
		pauseRecording: vi.fn(async () => {}),
		setMicInput: vi.fn(async (_name: string | null) => {}),
		setCameraInput: vi.fn(
			async (_id: PausedCameraId, _skip: boolean | null) => {},
		),
	};
	const close = vi.fn(async () => {});
	const getCameraWindow = vi.fn(async () => ({ close }));
	const refresh = vi.fn(async () => {});
	const mutations = createPausedMutations(
		<T>(factory: () => { mutationFn: (value: T) => Promise<void> }) => ({
			mutateAsync: factory().mutationFn,
		}),
		{ rawOptions: options, setOptions },
		commands,
		() => state,
		true,
		true,
		() => true,
		getCameraWindow,
		refresh,
		pausedStore.reconcile,
	);
	return {
		...mutations,
		options,
		commands,
		state,
		close,
		getCameraWindow,
		refresh,
	};
}

const pausedCamera = (
	id: string,
	model_id: string | null = null,
): PausedCamera => ({
	device_id: id,
	model_id,
	display_name: id,
});

describe("paused recording requested inputs", () => {
	it("keeps failed microphone B visible and sends an explicit A retry", async () => {
		const controls = pausedControls();
		controls.commands.setMicInput.mockRejectedValueOnce(new Error("B failed"));
		await expect(controls.updateMicInput.mutateAsync("B")).rejects.toThrow(
			"B failed",
		);
		expect(controls.options.micName).toBe("B");
		await controls.updateMicInput.mutateAsync("A");
		expect(controls.commands.setMicInput.mock.calls).toEqual([["B"], ["A"]]);
		expect(controls.options.micName).toBe("A");
	});

	it("retries the selected microphone including a failed None request", async () => {
		const controls = pausedControls();
		await controls.updateMicInput.mutateAsync("A");
		controls.commands.setMicInput.mockRejectedValueOnce(
			new Error("None failed"),
		);
		await expect(controls.updateMicInput.mutateAsync(null)).rejects.toThrow(
			"None failed",
		);
		expect(controls.options.micName).toBeNull();
		await controls.updateMicInput.mutateAsync(null);
		expect(controls.commands.setMicInput.mock.calls).toEqual([
			["A"],
			[null],
			[null],
		]);
	});

	it("does not overwrite or report an older failed microphone after a later choice", async () => {
		const controls = pausedControls();
		let rejectOld: (error: Error) => void = () => {};
		controls.commands.setMicInput.mockImplementationOnce(
			() =>
				new Promise<void>((_, reject) => {
					rejectOld = reject;
				}),
		);
		const old = controls.updateMicInput.mutateAsync("B");
		await Promise.resolve();
		await controls.updateMicInput.mutateAsync(null);
		rejectOld(new Error("B failed late"));
		await old;
		expect(controls.options.micName).toBeNull();
	});

	it("keeps failed camera B visible and sends an explicit A retry", async () => {
		const controls = pausedControls();
		controls.commands.setCameraInput.mockRejectedValueOnce(
			new Error("B failed"),
		);
		await expect(
			controls.updateCameraInput.mutateAsync(pausedCamera("B")),
		).rejects.toThrow("B failed");
		expect(controls.options.cameraID).toEqual({ DeviceID: "B" });
		await controls.updateCameraInput.mutateAsync(pausedCamera("A"));
		expect(controls.commands.setCameraInput.mock.calls).toEqual([
			[{ DeviceID: "B" }, null],
			[{ DeviceID: "A" }, null],
		]);
		expect(controls.options.cameraID).toEqual({ DeviceID: "A" });
	});

	it("retries the selected model camera and preserves its identifier form", async () => {
		const controls = pausedControls();
		controls.options.cameraID = { ModelID: "Model A" };
		await controls.updateCameraInput.mutateAsync(pausedCamera("A", "Model A"));
		expect(controls.commands.setCameraInput).toHaveBeenCalledWith(
			{ ModelID: "Model A" },
			null,
		);
		expect(controls.options.cameraID).toEqual({ ModelID: "Model A" });
	});

	it("reconciles identifier variants without retaining a different camera key", async () => {
		const controls = pausedControls();
		controls.commands.setCameraInput.mockRejectedValueOnce(
			new Error("Model B failed"),
		);
		await expect(
			controls.updateCameraInput.mutateAsync(pausedCamera("B", "Model B")),
		).rejects.toThrow("Model B failed");
		expect(controls.options.cameraID).toEqual({ ModelID: "Model B" });
		await controls.updateCameraInput.mutateAsync(pausedCamera("A"));
		expect(controls.options.cameraID).toEqual({ DeviceID: "A" });
		expect(controls.commands.setCameraInput.mock.calls).toEqual([
			[{ ModelID: "Model B" }, null],
			[{ DeviceID: "A" }, null],
		]);
	});

	it("does not overwrite or report an older failed camera after a later choice", async () => {
		const controls = pausedControls();
		let rejectOld: (error: Error) => void = () => {};
		controls.commands.setCameraInput.mockImplementationOnce(
			() =>
				new Promise<void>((_, reject) => {
					rejectOld = reject;
				}),
		);
		const old = controls.updateCameraInput.mutateAsync(pausedCamera("B"));
		await Promise.resolve();
		await controls.updateCameraInput.mutateAsync(null);
		rejectOld(new Error("B failed late"));
		await old;
		expect(controls.options.cameraID).toBeNull();
	});

	it("ignores backend supersession without erasing either current request", async () => {
		const controls = pausedControls();
		controls.commands.setMicInput.mockRejectedValueOnce(
			"Microphone selection was superseded by a newer request",
		);
		controls.commands.setCameraInput.mockRejectedValueOnce(
			"Camera selection was superseded by a newer request",
		);
		await controls.updateMicInput.mutateAsync("B");
		await controls.updateCameraInput.mutateAsync(pausedCamera("B"));
		expect(controls.options).toEqual({
			micName: "B",
			cameraID: { DeviceID: "B" },
		});
	});

	it("does not change requested inputs when acknowledged Pause fails", async () => {
		const controls = pausedControls();
		controls.state.variant = "recording";
		controls.commands.pauseRecording.mockRejectedValue(
			new Error("Pause failed"),
		);
		await expect(controls.updateMicInput.mutateAsync("B")).rejects.toThrow(
			"Pause failed",
		);
		await expect(
			controls.updateCameraInput.mutateAsync(pausedCamera("B")),
		).rejects.toThrow("Pause failed");
		expect(controls.options).toEqual({
			micName: "A",
			cameraID: { DeviceID: "A" },
		});
		expect(controls.commands.setMicInput).not.toHaveBeenCalled();
		expect(controls.commands.setCameraInput).not.toHaveBeenCalled();
	});

	it("waits for acknowledged Pause before storing and sending the requested input", async () => {
		const controls = pausedControls();
		controls.state.variant = "recording";
		let paused: () => void = () => {};
		controls.commands.pauseRecording.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					paused = resolve;
				}),
		);
		const request = controls.updateMicInput.mutateAsync("B");
		expect(controls.options.micName).toBe("A");
		expect(controls.commands.setMicInput).not.toHaveBeenCalled();
		paused();
		await request;
		expect(controls.options.micName).toBe("B");
		expect(controls.state.variant).toBe("recording");
	});

	it("keeps None after camera-window cleanup fails and retries it explicitly", async () => {
		const controls = pausedControls();
		controls.close.mockRejectedValueOnce(new Error("Close failed"));
		await expect(controls.updateCameraInput.mutateAsync(null)).rejects.toThrow(
			"Close failed",
		);
		expect(controls.options.cameraID).toBeNull();
		await controls.updateCameraInput.mutateAsync(null);
		expect(controls.commands.setCameraInput.mock.calls).toEqual([
			[null, null],
			[null, null],
		]);
		expect(controls.refresh).toHaveBeenCalledTimes(1);
	});

	it("does not close a newer camera after a delayed None completion", async () => {
		const controls = pausedControls();
		let finishOld: () => void = () => {};
		controls.commands.setCameraInput.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishOld = resolve;
				}),
		);
		const old = controls.updateCameraInput.mutateAsync(null);
		await Promise.resolve();
		await controls.updateCameraInput.mutateAsync(pausedCamera("B"));
		finishOld();
		await old;
		expect(controls.options.cameraID).toEqual({ DeviceID: "B" });
		expect(controls.close).not.toHaveBeenCalled();
	});

	it("rechecks the current camera after waiting for the preview window", async () => {
		const controls = pausedControls();
		let finishLookup: (window: { close: typeof controls.close }) => void =
			() => {};
		controls.getCameraWindow.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishLookup = resolve;
				}),
		);
		const old = controls.updateCameraInput.mutateAsync(null);
		await Promise.resolve();
		await Promise.resolve();
		await controls.updateCameraInput.mutateAsync(pausedCamera("B"));
		finishLookup({ close: controls.close });
		await old;
		expect(controls.close).not.toHaveBeenCalled();
		expect(controls.options.cameraID).toEqual({ DeviceID: "B" });
	});
});
