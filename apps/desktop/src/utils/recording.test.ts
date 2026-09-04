import * as dialog from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRecordingResult, isRecordingStartCancelled } from "./recording";

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("./tauri", () => ({ commands: {} }));

describe("recording start cancellation", () => {
	beforeEach(() => vi.clearAllMocks());

	it.each([
		"Recording cancelled before starting.",
		new Error("Recording cancelled before starting."),
	])("does not show another error after the user cancels", async (error) => {
		await handleRecordingResult(Promise.reject(error), undefined);
		expect(dialog.message).not.toHaveBeenCalled();
	});

	it.each([
		"Not enough storage to start recording.",
		"Recording cancelled before starting. Cleanup failed.",
		"Recording cancelled",
	])("still shows a real start failure: %s", async (message) => {
		expect(isRecordingStartCancelled(message)).toBe(false);
		await handleRecordingResult(Promise.reject(new Error(message)), undefined);
		expect(dialog.message).toHaveBeenCalledWith(message, {
			title: "Error starting recording",
			kind: "error",
		});
	});
});
