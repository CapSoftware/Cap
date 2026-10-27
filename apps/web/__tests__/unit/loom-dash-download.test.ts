// @vitest-environment jsdom

import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveLoomStreamAsMp4 } from "@/lib/loom-browser-conversion";

const sources = vi.hoisted(() => [] as Blob[]);
vi.mock("mediabunny", () => {
	class Empty {}
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
		ALL_FORMATS: [],
		Conversion: {},
		CustomPathedSource: Empty,
		UrlSource: Empty,
		canEncodeVideo: async () => true,
		canEncodeAudio: async () => true,
		BufferTarget: class {
			buffer = new Uint8Array([9]).buffer;
		},
		StreamTarget: Empty,
		Mp4OutputFormat: Empty,
		WEBM: {},
		QUALITY_HIGH: 1,
		QUALITY_MEDIUM: 0.5,
		BlobSource: class {
			constructor(blob: Blob) {
				sources.push(blob);
			}
		},
		Input: class {
			async getPrimaryVideoTrack() {
				return {};
			}
			async getPrimaryAudioTrack() {
				return {};
			}
			dispose() {}
		},
		Output: class {
			state = "started";
			addVideoTrack() {}
			addAudioTrack() {}
			async start() {}
			async finalize() {}
			async cancel() {}
		},
		VideoSampleSource: SampleSource,
		AudioSampleSource: SampleSource,
		VideoSampleSink: SampleSink,
		AudioSampleSink: SampleSink,
	};
});

const track = (kind: string) =>
	`<AdaptationSet contentType="${kind}"><Representation id="${kind}" bandwidth="1000" mimeType="${kind}/webm" codecs="${kind === "video" ? "vp9" : "opus"}"><SegmentTemplate initialization="${kind}-init.webm" media="${kind}-$Number$.webm" timescale="1"><SegmentTimeline><S d="1" r="1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>`;
const manifest = (audio: boolean) =>
	`<MPD mediaPresentationDuration="PT2S"><Period>${track("video")}${audio ? track("audio") : ""}</Period></MPD>`;
const convert = (options = {}) =>
	saveLoomStreamAsMp4({
		url: "https://cdn.example/manifest.mpd",
		filename: "video.mp4",
		...options,
	});

beforeEach(() => {
	sources.length = 0;
	vi.stubGlobal("Blob", NodeBlob);
	for (const key of [
		"VideoDecoder",
		"VideoEncoder",
		"AudioDecoder",
		"AudioEncoder",
	])
		vi.stubGlobal(key, class {});
	vi.stubGlobal("showSaveFilePicker", undefined);
});
afterEach(() => vi.unstubAllGlobals());

it.each([false, true])(
	"preserves init/segment bytes despite reversed body completion (audio: %s)",
	async (audio) => {
		const releases = new Map<string, () => void>();
		const completed: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				if (input.endsWith(".mpd")) return new Response(manifest(audio));
				const name = input.split("/").at(-1) ?? "";
				const index = name.includes("init")
					? 0
					: Number(name.match(/-(\d)/)?.[1]);
				return new Response(
					new ReadableStream({
						start(controller) {
							releases.set(name, () => {
								controller.enqueue(new Uint8Array([index, 255]));
								controller.enqueue(new Uint8Array([index + 16]));
								controller.close();
								completed.push(name);
							});
						},
					}),
				);
			}),
		);
		const progress = vi.fn();
		const controller = new AbortController();
		const result = convert({ signal: controller.signal, onProgress: progress });
		await vi.waitFor(() => expect(releases.size).toBe(audio ? 6 : 3));
		for (const kind of audio ? ["audio", "video"] : ["video"]) {
			for (const suffix of ["2", "1", "init"])
				releases.get(`${kind}-${suffix}.webm`)?.();
		}
		await expect(result).resolves.toMatchObject({ type: "video/mp4", size: 1 });
		expect(completed.slice(0, 3)).toEqual([
			`${audio ? "audio" : "video"}-2.webm`,
			`${audio ? "audio" : "video"}-1.webm`,
			`${audio ? "audio" : "video"}-init.webm`,
		]);
		expect(sources).toHaveLength(audio ? 2 : 1);
		for (const blob of sources) {
			expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([
				0, 255, 16, 1, 255, 17, 2, 255, 18,
			]);
		}
		expect(sources.map((blob) => blob.type)).toEqual(
			audio ? ["video/webm", "audio/webm"] : ["video/webm"],
		);
		expect(progress).toHaveBeenLastCalledWith({
			percent: 100,
			processedSeconds: 2,
		});
		for (const [, options] of vi.mocked(fetch).mock.calls)
			expect(options?.signal).toBe(controller.signal);
	},
);

it("preserves bytes around an empty successful segment", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string) => {
			if (input.endsWith(".mpd")) return new Response(manifest(false));
			return new Response(
				input.includes("-1.webm") ? null : new Uint8Array([7, 0, 255]),
			);
		}),
	);
	await convert();
	const blob = sources[0];
	if (!blob) throw new Error("Missing decoder input");
	expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([
		7, 0, 255, 7, 0, 255,
	]);
});

it("does not pass a partial track to the decoder when a response body fails", async () => {
	const error = new Error("Interrupted media body");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string) => {
			if (input.endsWith(".mpd")) return new Response(manifest(false));
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array([1]));
						controller.error(error);
					},
				}),
			);
		}),
	);
	await expect(convert()).rejects.toMatchObject({ cause: error });
	expect(sources).toHaveLength(0);
});

it("stops conversion when a pending media body is aborted", async () => {
	const controller = new AbortController();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, options?: RequestInit) => {
			if (input.endsWith(".mpd")) return new Response(manifest(false));
			return new Response(
				new ReadableStream({
					start(body) {
						body.enqueue(new Uint8Array([1]));
						options?.signal?.addEventListener(
							"abort",
							() => {
								body.error(new DOMException("Cancelled", "AbortError"));
							},
							{ once: true },
						);
					},
				}),
			);
		}),
	);
	const result = convert({ signal: controller.signal });
	const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
	await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
	controller.abort();
	await rejected;
	expect(sources).toHaveLength(0);
});
