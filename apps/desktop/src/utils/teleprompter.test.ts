import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TestEvent = { payload: unknown };
type TestListener = (event: TestEvent) => void;
type CreatedWindow = {
	label: string;
	options: Record<string, unknown>;
	listeners: Map<string, TestListener>;
};

const mocks = vi.hoisted(() => {
	const calls: string[] = [];
	const existingWindow = {
		innerPosition: vi.fn(async () => {
			calls.push("innerPosition");
		}),
		unminimize: vi.fn(async () => {
			calls.push("unminimize");
		}),
		show: vi.fn(async () => {
			calls.push("show");
		}),
		setFocus: vi.fn(async () => {
			calls.push("focus");
		}),
		destroy: vi.fn(async () => {
			calls.push("destroy");
		}),
	};
	const openerWindow = {
		setFocus: vi.fn(async () => {
			calls.push("openerFocus");
		}),
	};

	return {
		calls,
		existingWindow,
		openerWindow,
		state: {
			existingWindow: null as typeof existingWindow | null,
			createdWindow: undefined as CreatedWindow | undefined,
		},
		getCurrent: vi.fn(() => openerWindow),
		getByLabel: vi.fn(async () => null as typeof existingWindow | null),
		osType: vi.fn(() => "macos"),
		refreshWindowContentProtection: vi.fn(async () => {
			calls.push("refresh");
			return null;
		}),
	};
});

vi.mock("@tauri-apps/api/webviewWindow", () => ({
	WebviewWindow: class {
		static getCurrent = mocks.getCurrent;
		static getByLabel = vi.fn(async () => mocks.state.existingWindow);

		label: string;
		options: Record<string, unknown>;
		listeners = new Map<string, TestListener>();

		constructor(label: string, options: Record<string, unknown> = {}) {
			this.label = label;
			this.options = options;
			mocks.state.createdWindow = this;
		}

		once(event: string, listener: TestListener) {
			this.listeners.set(event, listener);
			return Promise.resolve(() => undefined);
		}
	},
}));

vi.mock("@tauri-apps/plugin-os", () => ({ type: mocks.osType }));

vi.mock("./tauri", () => ({
	commands: {
		refreshWindowContentProtection: mocks.refreshWindowContentProtection,
	},
}));

describe("openTeleprompter on macOS", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		mocks.calls.length = 0;
		mocks.state.existingWindow = null;
		mocks.state.createdWindow = undefined;
		mocks.osType.mockReturnValue("macos");
		vi.stubGlobal("window", { __CAP__: {} });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("preserves the existing-window refresh and focus sequence", async () => {
		mocks.state.existingWindow = mocks.existingWindow;
		const { openTeleprompter } = await import("./teleprompter");

		await openTeleprompter();

		expect(mocks.calls).toEqual(["refresh", "unminimize", "show", "focus"]);
		expect(mocks.existingWindow.innerPosition).not.toHaveBeenCalled();
		expect(mocks.existingWindow.destroy).not.toHaveBeenCalled();
		expect(mocks.getCurrent).not.toHaveBeenCalled();
	});

	it("preserves creation focus and content-protection timing", async () => {
		const { openTeleprompter } = await import("./teleprompter");

		await openTeleprompter();

		const createdWindow = mocks.state.createdWindow;
		expect(createdWindow?.options).toMatchObject({
			focus: true,
			visible: false,
			decorations: true,
			additionalBrowserArgs: undefined,
		});
		expect(mocks.getCurrent).not.toHaveBeenCalled();
		expect(mocks.refreshWindowContentProtection).not.toHaveBeenCalled();

		createdWindow?.listeners.get("tauri://created")?.({ payload: null });

		await vi.waitFor(() => {
			expect(mocks.calls).toEqual(["refresh"]);
		});
	});
});
