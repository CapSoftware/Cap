import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FrameData } from "~/utils/socket";
import { createPreparingEditorSession } from "./preparing-editor-context";

const { commitFrame, stopFrame } = vi.hoisted(() => ({
	commitFrame: vi.fn<() => Promise<boolean>>(),
	stopFrame: vi.fn(async () => {}),
}));

vi.mock("~/utils/tauri", () => ({
	commands: {
		commitEditorPreparingFrame: commitFrame,
		stopPreparingEditorFrame: stopFrame,
	},
	events: {},
}));

const frame: FrameData = {
	width: 1920,
	height: 1080,
	renderedFrame: { frameNumber: 0, targetTimeNs: 0n },
};
const bounds = { width: 640, height: 360 };
const cleanups: Array<() => void> = [];

function sessionWithCandidate(retry: () => Promise<unknown>) {
	return createRoot((dispose) => {
		cleanups.push(dispose);
		const session = createPreparingEditorSession();
		session.beginHandoff(30, 10, {
			instanceId: "first",
			fps: 30,
			progressive: true,
			retry,
			requestFrame() {},
		});
		return { session, dispose };
	});
}

afterEach(() => {
	for (const dispose of cleanups.splice(0)) dispose();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("preparing editor handoff recovery", () => {
	it("surfaces a commit failure and enables editing only after retry is accepted", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		commitFrame.mockRejectedValueOnce(new Error("connection lost"));
		commitFrame.mockResolvedValueOnce(true);
		const retry = vi.fn(async () => {});
		const { session } = sessionWithCandidate(retry);
		session.acknowledgeOrdinaryFrame(frame, bounds);
		await vi.waitFor(() => expect(session.handoffFailed()).toBe(true));
		expect(session.ordinaryReady()).toBe(false);
		await session.retryHandoff();
		expect(retry).toHaveBeenCalledOnce();
		expect(session.handoffFailed()).toBe(false);
		expect(session.ordinaryReady()).toBe(false);
		session.acknowledgeOrdinaryFrame(frame, bounds);
		await vi.waitFor(() => expect(session.ordinaryReady()).toBe(true));
		expect(session.handoffFailed()).toBe(false);
	});

	it("keeps recovery available when replacing the candidate fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		commitFrame.mockRejectedValueOnce(
			"Preparing handoff candidate was superseded",
		);
		const retry = vi.fn(async () => {
			throw new Error("replacement failed");
		});
		const { session } = sessionWithCandidate(retry);
		session.acknowledgeOrdinaryFrame(frame, bounds);
		await vi.waitFor(() => expect(session.handoffFailed()).toBe(true));
		expect(retry).toHaveBeenCalledOnce();
		await session.retryHandoff();
		expect(retry).toHaveBeenCalledTimes(2);
		expect(session.handoffFailed()).toBe(true);
		expect(session.ordinaryReady()).toBe(false);
	});

	it("ignores a rejected handoff after the editor has closed", async () => {
		let reject!: (error: Error) => void;
		commitFrame.mockImplementationOnce(
			() =>
				new Promise<boolean>((_, fail) => {
					reject = fail;
				}),
		);
		const { session, dispose } = sessionWithCandidate(async () => {});
		session.acknowledgeOrdinaryFrame(frame, bounds);
		dispose();
		reject(new Error("late failure"));
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(session.handoffFailed()).toBe(false);
		expect(session.ordinaryReady()).toBe(false);
	});
});
