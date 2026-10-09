// @vitest-environment jsdom

import { Blob as NodeBlob } from "node:buffer";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaRecorderSetup } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useMediaRecorderSetup";

describe("MediaRecorder failure recovery", () => {
	let root: Root;
	let container: HTMLDivElement;
	let setup: ReturnType<typeof useMediaRecorderSetup>;
	let recorder: { state: RecordingState; stop: ReturnType<typeof vi.fn> };

	beforeEach(async () => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal("Blob", NodeBlob);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		function Harness() {
			setup = useMediaRecorderSetup();
			return null;
		}
		await act(async () => root.render(createElement(Harness)));
		recorder = {
			state: "recording",
			stop: vi.fn(() => {
				recorder.state = "inactive";
			}),
		};
		setup.mediaRecorderRef.current = recorder as unknown as MediaRecorder;
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	const chunk = (text: string) => ({ data: new Blob([text]) }) as BlobEvent;
	const errorEvent = (error: DOMException) =>
		Object.assign(new Event("error"), { error });

	it("includes the final data event in a normal stop", async () => {
		setup.onRecorderDataAvailable(chunk("first"));
		const cleanup = vi.fn();
		const clearTimer = vi.fn();
		const stopped = setup.stopRecordingInternal(cleanup, clearTimer);
		setup.onRecorderDataAvailable(chunk("last"));
		await act(async () => setup.onRecorderStop());
		expect(await (await stopped)?.text()).toBe("firstlast");
		expect(setup.recorderError).toBeNull();
		expect(cleanup).toHaveBeenCalledOnce();
		expect(clearTimer).toHaveBeenCalledOnce();
	});

	it("waits for final data before surfacing a runtime encoder failure", async () => {
		setup.onRecorderDataAvailable(chunk("first"));
		const error = new DOMException("Encoder failed", "UnknownError");
		setup.onRecorderError(errorEvent(error));
		expect(setup.recorderError).toBeNull();
		recorder.state = "inactive";
		setup.onRecorderDataAvailable(chunk("recoverable-tail"));
		await act(async () => setup.onRecorderStop());
		expect(setup.recorderError).toBe(error);
		const cleanup = vi.fn();
		const clearTimer = vi.fn();
		await expect(setup.stopRecordingInternal(cleanup, clearTimer)).rejects.toBe(
			error,
		);
		expect(await setup.getRecoveryBlob()?.text()).toBe("firstrecoverable-tail");
		expect(cleanup).toHaveBeenCalledOnce();
		expect(clearTimer).toHaveBeenCalledOnce();
	});

	it("waits for the final chunk when the source ends before the stop event", async () => {
		setup.onRecorderDataAvailable(chunk("first"));
		recorder.state = "inactive";
		let finished = false;
		const stopped = setup
			.stopRecordingInternal(vi.fn(), vi.fn())
			.then((blob) => {
				finished = true;
				return blob;
			});
		await Promise.resolve();
		expect(finished).toBe(false);
		expect(recorder.stop).not.toHaveBeenCalled();
		setup.onRecorderDataAvailable(chunk("last"));
		await act(async () => setup.onRecorderStop());
		expect(await (await stopped)?.text()).toBe("firstlast");
	});

	it("joins an in-flight stop while the recorder is inactive and awaits its tail", async () => {
		setup.onRecorderDataAvailable(chunk("first"));
		const cleanup = vi.fn();
		const stopped = setup.stopRecordingInternal(cleanup, vi.fn());
		expect(recorder.state).toBe("inactive");
		let finished = false;
		const joined = setup
			.stopRecordingInternal(cleanup, vi.fn())
			.then((blob) => {
				finished = true;
				return blob;
			});
		await Promise.resolve();
		expect(finished).toBe(false);
		setup.onRecorderDataAvailable(chunk("last"));
		await act(async () => setup.onRecorderStop());
		expect(await (await stopped)?.text()).toBe("firstlast");
		expect(await (await joined)?.text()).toBe("firstlast");
		expect(recorder.stop).toHaveBeenCalledOnce();
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it("bounds a missing stop event without discarding recorded data", async () => {
		vi.useFakeTimers();
		setup.onRecorderDataAvailable(chunk("saved"));
		const stopped = setup
			.stopRecordingInternal(vi.fn(), vi.fn())
			.catch((error: unknown) => error);
		await act(async () => vi.advanceTimersByTimeAsync(30_000));
		expect(await stopped).toEqual(
			new Error("The browser did not finish recording in time"),
		);
		expect(await setup.getRecoveryBlob()?.text()).toBe("saved");
	});

	it("settles a pending stop when reset and allows the next recording to stop", async () => {
		const stopped = setup
			.stopRecordingInternal(vi.fn(), vi.fn())
			.catch((error: unknown) => error);
		await act(async () => setup.resetRecorder());
		expect(await stopped).toEqual(new Error("Recording was reset"));
		recorder.state = "recording";
		setup.mediaRecorderRef.current = recorder as unknown as MediaRecorder;
		setup.onRecorderDataAvailable(chunk("next"));
		const next = setup.stopRecordingInternal(vi.fn(), vi.fn());
		await act(async () => setup.onRecorderStop());
		expect(await (await next)?.text()).toBe("next");
	});

	it("rejects a pending stop after keeping the final error data", async () => {
		setup.onRecorderDataAvailable(chunk("first"));
		const stopped = setup
			.stopRecordingInternal(vi.fn(), vi.fn())
			.catch((error: unknown) => error);
		const error = new DOMException("Finalization failed", "UnknownError");
		setup.onRecorderError(errorEvent(error));
		setup.onRecorderDataAvailable(chunk("last"));
		await act(async () => setup.onRecorderStop());
		expect(await stopped).toBe(error);
		expect(await setup.getRecoveryBlob()?.text()).toBe("firstlast");
	});

	it("preserves data when the browser stops without an error event", async () => {
		setup.onRecorderDataAvailable(chunk("recoverable"));
		recorder.state = "inactive";
		await act(async () => setup.onRecorderStop());
		expect(setup.recorderError?.message).toContain("unexpectedly");
		expect(await setup.getRecoveryBlob()?.text()).toBe("recoverable");
	});

	it("ignores late events from a recorder that has been reset", async () => {
		const previousRecorder = setup.mediaRecorderRef.current;
		await act(async () => setup.resetRecorder());
		const lateEvent = (event: Event) =>
			Object.defineProperty(event, "target", { value: previousRecorder });
		const onChunk = vi.fn();
		setup.onRecorderDataAvailable(
			lateEvent(chunk("old recording")) as BlobEvent,
			onChunk,
		);
		setup.onRecorderError(
			lateEvent(errorEvent(new DOMException("Old recorder failed"))),
		);
		await act(async () => setup.onRecorderStop(lateEvent(new Event("stop"))));
		expect(setup.recorderError).toBeNull();
		expect(setup.getRecoveryBlob()).toBeNull();
		expect(onChunk).not.toHaveBeenCalled();
	});

	it("allows a successful recording after a failed recording is reset", async () => {
		setup.onRecorderError(errorEvent(new DOMException("Encoder failed")));
		await act(async () => setup.onRecorderStop());
		await act(async () => setup.resetRecorder());
		expect(setup.recorderError).toBeNull();
		setup.mediaRecorderRef.current = recorder as unknown as MediaRecorder;
		setup.onRecorderDataAvailable(chunk("new recording"));
		const stopped = setup.stopRecordingInternal(vi.fn(), vi.fn());
		await act(async () => setup.onRecorderStop());
		expect(await (await stopped)?.text()).toBe("new recording");
	});
});
