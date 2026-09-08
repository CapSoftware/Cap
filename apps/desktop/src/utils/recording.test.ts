import * as dialog from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleRecordingResult,
	isRecordingStartCancelled,
	runRecordingStopRequest,
} from "./recording";

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

describe("recording stop requests", () => {
	it("releases a failed request so Stop can be retried while retaining the error", async () => {
		let pending = true;
		let error: unknown;
		const failure = new Error("Windows are still restoring");
		const stop = vi
			.fn()
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce(undefined);
		const options = {
			stop,
			isCurrent: () => pending,
			onError: (value: unknown) => {
				error = value;
			},
			onSettled: () => {
				pending = false;
			},
		};
		await runRecordingStopRequest(options);
		expect(pending).toBe(false);
		expect(error).toBe(failure);
		pending = true;
		await runRecordingStopRequest(options);
		expect(stop).toHaveBeenCalledTimes(2);
		expect(pending).toBe(false);
		expect(error).toBe(failure);
	});

	it.each([false, true])(
		"ignores a stale completion after a new recording starts (failure: %s)",
		async (fails) => {
			let finish: () => void = () => {};
			const stopped = new Promise<void>((resolve) => {
				finish = resolve;
			});
			let current = true;
			const onError = vi.fn();
			const onSettled = vi.fn();
			const pending = runRecordingStopRequest({
				stop: async () => {
					await stopped;
					if (fails) throw new Error("Old stop error");
				},
				isCurrent: () => current,
				onError,
				onSettled,
			});
			current = false;
			finish();
			await pending;
			expect(onError).not.toHaveBeenCalled();
			expect(onSettled).not.toHaveBeenCalled();
		},
	);
});
