// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveLoomStreamAsMp4 } from "@/lib/loom-browser-conversion";

const mocks = vi.hoisted(() => ({
	hasAudio: false,
	canEncodeVideo: vi.fn(),
	canEncodeAudio: vi.fn(),
	dispose: vi.fn(),
	cancel: vi.fn(),
	execute: vi.fn(),
}));
vi.mock("mediabunny", () => {
	class Source {}
	class SampleSource {
		async add() {}
		close() {}
	}
	class SampleSink {
		samples() {
			return [];
		}
	}
	return {
		canEncodeVideo: mocks.canEncodeVideo,
		canEncodeAudio: mocks.canEncodeAudio,
		BufferTarget: class {
			buffer = new Uint8Array([1, 2, 3]).buffer;
		},
		StreamTarget: Source,
		CustomPathedSource: Source,
		UrlSource: Source,
		BlobSource: Source,
		Mp4OutputFormat: Source,
		ALL_FORMATS: [],
		WEBM: {},
		QUALITY_HIGH: 1,
		QUALITY_MEDIUM: 0.5,
		Input: class {
			async getPrimaryVideoTrack() {
				return {};
			}
			async getPrimaryAudioTrack() {
				return mocks.hasAudio ? {} : null;
			}
			dispose = mocks.dispose;
		},
		Output: class {
			state = "started";
			cancel = mocks.cancel;
			addVideoTrack() {}
			addAudioTrack() {}
			async start() {}
			async finalize() {}
		},
		VideoSampleSource: SampleSource,
		AudioSampleSource: SampleSource,
		VideoSampleSink: SampleSink,
		AudioSampleSink: SampleSink,
		Conversion: {
			init: async () => ({
				isValid: true,
				discardedTracks: [],
				execute: mocks.execute,
				output: { cancel: mocks.cancel },
			}),
		},
	};
});

beforeEach(() => {
	for (const key of [
		"VideoDecoder",
		"VideoEncoder",
		"AudioDecoder",
		"AudioEncoder",
	])
		vi.stubGlobal(key, class {});
	vi.stubGlobal("showSaveFilePicker", undefined);
	mocks.hasAudio = false;
	mocks.canEncodeVideo.mockReset().mockResolvedValue(true);
	mocks.canEncodeAudio.mockReset().mockResolvedValue(false);
	mocks.dispose.mockClear();
	mocks.cancel.mockReset().mockResolvedValue(undefined);
	mocks.execute.mockReset().mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string) => {
			if (!input.endsWith(".mpd"))
				return new Response(new Uint8Array([1, 2, 3]));
			const track = (kind: string, codec: string) =>
				`<AdaptationSet contentType="${kind}"><Representation id="${kind}" bandwidth="1000" mimeType="${kind}/webm" codecs="${codec}" width="320" height="180"><SegmentTemplate initialization="${kind}-init.webm" media="${kind}-$Number$.webm" timescale="1"><SegmentTimeline><S d="1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>`;
			return new Response(
				`<MPD mediaPresentationDuration="PT1S"><Period>${track("video", "vp9")}${mocks.hasAudio ? track("audio", "opus") : ""}</Period></MPD>`,
			);
		}),
	);
});
afterEach(() => vi.unstubAllGlobals());

describe.each(["video.webm", "manifest.mpd"])(
	"Loom codec requirements for %s",
	(path) => {
		const convert = () =>
			saveLoomStreamAsMp4({
				url: `https://cdn.example/${path}`,
				filename: "video.mp4",
			});

		it("converts a silent source without requiring an AAC encoder", async () => {
			const result = await convert();
			expect(result?.type).toBe("video/mp4");
			expect(result?.size).toBe(3);
			expect(mocks.canEncodeVideo).toHaveBeenCalledWith("avc");
			expect(mocks.canEncodeAudio).not.toHaveBeenCalled();
			expect(mocks.dispose).toHaveBeenCalled();
		});

		it("still rejects an audio source when AAC encoding is unavailable", async () => {
			mocks.hasAudio = true;
			await expect(convert()).rejects.toThrow("latest desktop Chrome or Edge");
			expect(mocks.canEncodeAudio).toHaveBeenCalledWith("aac");
			expect(mocks.execute).not.toHaveBeenCalled();
		});

		it("keeps audio conversion available when AAC encoding is supported", async () => {
			mocks.hasAudio = true;
			mocks.canEncodeAudio.mockResolvedValue(true);
			const result = await convert();
			expect(result?.type).toBe("video/mp4");
			expect(mocks.canEncodeAudio).toHaveBeenCalledWith("aac");
			expect(mocks.dispose).toHaveBeenCalled();
		});
	},
);

it("rejects unsupported AVC before fetching media", async () => {
	mocks.canEncodeVideo.mockResolvedValue(false);
	await expect(
		saveLoomStreamAsMp4({
			url: "https://cdn.example/video.webm",
			filename: "video.mp4",
		}),
	).rejects.toThrow("latest desktop Chrome or Edge");
	expect(fetch).not.toHaveBeenCalled();
});
