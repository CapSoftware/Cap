import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AudioRecordingSidecar } from "../src/audio-sidecar";
import type { VideoId } from "../src/recorder-types";

const mocks = vi.hoisted(() => ({
	createSpool: vi.fn(),
	secureSessionId: vi.fn(),
	initiate: vi.fn(),
	uploaders: [] as Array<{
		handleChunk: ReturnType<typeof vi.fn>;
		finalize: ReturnType<typeof vi.fn>;
		cancel: ReturnType<typeof vi.fn>;
	}>,
}));

vi.mock("../src/recorder-utils", () => ({
	selectAudioRecordingPipeline: () => ({
		mimeType: "audio/webm;codecs=opus",
		fileExtension: "webm",
	}),
}));

vi.mock("../src/recording-spool", () => ({
	createRecordingSessionId: mocks.secureSessionId,
	RecordingSpool: { create: mocks.createSpool },
}));

vi.mock("../src/instant-mp4-uploader", () => ({
	initiateMultipartUpload: mocks.initiate,
	InstantRecordingUploader: class {
		handleChunk = vi.fn();
		finalize = vi.fn(async () => undefined);
		cancel = vi.fn(async () => undefined);
		constructor() {
			mocks.uploaders.push(this);
		}
	},
}));

class FakeAudioRecorder extends EventTarget {
	static instances: FakeAudioRecorder[] = [];
	state: RecordingState = "inactive";
	constructor() {
		super();
		FakeAudioRecorder.instances.push(this);
	}
	start() {
		this.state = "recording";
	}
	stop() {
		this.state = "inactive";
		this.dispatchEvent(new Event("stop"));
	}
	requestData() {}
	emitData(data: Blob) {
		const event = new Event("dataavailable") as BlobEvent;
		Object.defineProperty(event, "data", { value: data });
		this.dispatchEvent(event);
	}
}

const stream = {
	getAudioTracks: () => [{ kind: "audio" }],
} as unknown as MediaStream;

const fatal = vi.fn();
const backupFallback = vi.fn();

beforeEach(() => {
	mocks.createSpool.mockReset();
	mocks.secureSessionId.mockReset();
	mocks.secureSessionId.mockReturnValue("secure-audio-session");
	mocks.initiate.mockResolvedValue({ uploadId: "upload", provider: "s3" });
	mocks.uploaders.length = 0;
	FakeAudioRecorder.instances = [];
	fatal.mockReset();
	backupFallback.mockReset();
	vi.stubGlobal("MediaRecorder", FakeAudioRecorder);
	vi.stubGlobal("window", {
		setInterval: () => 1,
		clearInterval: () => undefined,
		setTimeout,
		clearTimeout,
	});
});

afterEach(() => vi.unstubAllGlobals());

async function createSidecar() {
	return AudioRecordingSidecar.create({
		kind: "mic",
		stream,
		videoId: "video" as VideoId,
		screenSubpath: "raw-upload.webm",
		onFatalError: fatal,
		onBackupFallback: backupFallback,
	});
}

test("audio upload keeps a bounded backup when browser storage is unavailable", async () => {
	mocks.createSpool.mockRejectedValue(new Error("IndexedDB quota unavailable"));
	const sidecar = await createSidecar();
	expect(sidecar.metadata.sessionId).toBe("secure-audio-session");
	sidecar.start(performance.now());
	FakeAudioRecorder.instances[0]?.emitData(new Blob(["microphone"]));
	await sidecar.finalize(2);
	expect(mocks.uploaders[0]?.handleChunk).toHaveBeenCalledOnce();
	expect(mocks.uploaders[0]?.finalize).toHaveBeenCalledOnce();
	expect(backupFallback).toHaveBeenCalledOnce();
	expect(fatal).not.toHaveBeenCalled();
	expect(await (await sidecar.recoverBlob())?.text()).toBe("microphone");
	await sidecar.disposeBackup();
	expect(await sidecar.recoverBlob()).toBeNull();
});

test("a missing secure random source cancels the unused audio upload", async () => {
	mocks.createSpool.mockRejectedValue(new Error("IndexedDB unavailable"));
	mocks.secureSessionId.mockImplementationOnce(() => {
		throw new Error("Secure random source is unavailable");
	});

	await expect(createSidecar()).rejects.toThrow(
		"Secure random source is unavailable",
	);
	expect(mocks.uploaders[0]?.cancel).toHaveBeenCalledOnce();
	expect(FakeAudioRecorder.instances[0]?.state).toBe("inactive");
});

test("a stalled spool flush after a write failure keeps streamed audio and a full recovery copy", async () => {
	const first = new Blob(["first"]);
	const spool = {
		sessionId: "durable-spool",
		totalBytes: 0,
		appendChunk: vi.fn(async () => {
			throw new Error("IndexedDB write failed");
		}),
		flush: vi.fn(() => new Promise<void>(() => undefined)),
		recoverBlob: vi.fn(async () => null),
		dispose: vi.fn(async () => undefined),
		touch: vi.fn(async () => undefined),
	};
	mocks.createSpool.mockResolvedValue(spool);
	const sidecar = await createSidecar();
	sidecar.start(performance.now());
	FakeAudioRecorder.instances[0]?.emitData(first);
	await vi.waitFor(() => expect(backupFallback).toHaveBeenCalledOnce());
	FakeAudioRecorder.instances[0]?.emitData(new Blob(["second"]));
	await sidecar.finalize(2);
	expect(await (await sidecar.recoverBlob())?.text()).toBe("firstsecond");
	expect(mocks.uploaders[0]?.handleChunk).toHaveBeenCalledTimes(2);
	expect(mocks.uploaders[0]?.finalize).toHaveBeenCalledOnce();
	expect(fatal).not.toHaveBeenCalled();
	await sidecar.disposeBackup();
	expect(spool.dispose).toHaveBeenCalledOnce();
});
