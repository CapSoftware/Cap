// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveLoomStreamAsMp4 } from "@/lib/loom-browser-conversion";

const mocks = vi.hoisted(() => ({
	video: vi.fn(),
	audio: vi.fn(),
	init: vi.fn(),
	execute: vi.fn(),
	cancel: vi.fn(),
	dispose: vi.fn(),
	abort: vi.fn(),
}));
vi.mock("mediabunny", () => {
	class Empty {}
	return {
		ALL_FORMATS: [],
		QUALITY_HIGH: 1,
		QUALITY_MEDIUM: 1,
		CustomPathedSource: Empty,
		UrlSource: Empty,
		Mp4OutputFormat: Empty,
		BufferTarget: class {
			buffer = new Uint8Array([1]).buffer;
		},
		StreamTarget: Empty,
		Input: class {
			dispose = mocks.dispose;
		},
		Output: class {
			cancel = mocks.cancel;
		},
		canEncodeVideo: mocks.video,
		canEncodeAudio: mocks.audio,
		Conversion: { init: mocks.init },
	};
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
beforeEach(() => {
	for (const key of [
		"VideoDecoder",
		"VideoEncoder",
		"AudioDecoder",
		"AudioEncoder",
	])
		vi.stubGlobal(key, class {});
	vi.stubGlobal("showSaveFilePicker", undefined);
	mocks.video.mockReset().mockResolvedValue(true);
	mocks.audio.mockReset().mockResolvedValue(true);
	mocks.execute.mockReset().mockResolvedValue(undefined);
	mocks.cancel.mockReset().mockResolvedValue(undefined);
	mocks.dispose.mockReset();
	mocks.abort.mockReset().mockResolvedValue(undefined);
	mocks.init.mockReset().mockResolvedValue({
		isValid: true,
		discardedTracks: [],
		execute: mocks.execute,
		cancel: mocks.cancel,
		output: { cancel: mocks.cancel },
	});
});
afterEach(() => vi.unstubAllGlobals());
const start = (signal: AbortSignal) =>
	saveLoomStreamAsMp4({
		url: "https://example.com/video.m3u8",
		filename: "video.mp4",
		signal,
	});
it("does not open the save picker when aborted during codec checks", async () => {
	const gate = deferred<boolean>();
	mocks.video.mockReturnValueOnce(gate.promise);
	const picker = vi.fn();
	vi.stubGlobal("showSaveFilePicker", picker);
	const controller = new AbortController();
	const result = start(controller.signal);
	const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
	await vi.waitFor(() => expect(mocks.video).toHaveBeenCalled());
	controller.abort();
	gate.resolve(true);
	await rejected;
	expect(picker).not.toHaveBeenCalled();
	expect(mocks.init).not.toHaveBeenCalled();
});
it("does not execute when aborted while conversion initializes", async () => {
	const gate = deferred<object>();
	mocks.init.mockReturnValueOnce(gate.promise);
	const controller = new AbortController();
	const result = start(controller.signal);
	const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
	await vi.waitFor(() => expect(mocks.init).toHaveBeenCalled());
	controller.abort();
	gate.resolve({
		isValid: true,
		discardedTracks: [],
		execute: mocks.execute,
		cancel: mocks.cancel,
		output: { cancel: mocks.cancel },
	});
	await rejected;
	expect(mocks.execute).not.toHaveBeenCalled();
	expect(mocks.cancel).toHaveBeenCalled();
	expect(mocks.dispose).toHaveBeenCalled();
});
it("aborts the writable when cancellation arrives while the picker is open", async () => {
	const gate = deferred<object>();
	const picker = vi.fn(() => gate.promise);
	vi.stubGlobal("showSaveFilePicker", picker);
	const controller = new AbortController();
	const result = start(controller.signal);
	const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
	await vi.waitFor(() => expect(picker).toHaveBeenCalled());
	controller.abort();
	gate.resolve({ createWritable: async () => ({ abort: mocks.abort }) });
	await rejected;
	expect(mocks.abort).toHaveBeenCalled();
	expect(mocks.init).not.toHaveBeenCalled();
});
