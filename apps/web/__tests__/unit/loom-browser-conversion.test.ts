import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getLoomBrowserConversionErrorMessage,
	getLoomBrowserConversionSupport,
	isLoomBrowserConversionAbort,
	LoomBrowserConversionError,
	parseLoomDashManifest,
	saveLoomStreamAsMp4,
} from "@/lib/loom-browser-conversion";

describe("loom-browser-conversion", () => {
	beforeEach(() => {
		vi.stubGlobal("DOMParser", new JSDOM().window.DOMParser);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reports the required browser APIs when conversion is unsupported", () => {
		const support = getLoomBrowserConversionSupport({
			isSecureContext: true,
			VideoDecoder: {},
			VideoEncoder: {},
		});

		expect(support.supported).toBe(false);
		expect(support.missing).toEqual([
			"WebCodecs audio decoding",
			"WebCodecs audio encoding",
			"browser file streaming",
		]);
		expect(support.message).toContain("latest desktop Chrome or Edge");
	});

	it("accepts a browser with WebCodecs and save-file streaming", () => {
		const support = getLoomBrowserConversionSupport({
			isSecureContext: true,
			VideoDecoder: {},
			VideoEncoder: {},
			AudioDecoder: {},
			AudioEncoder: {},
			WritableStream: {},
		});

		expect(support).toEqual({
			supported: true,
			missing: [],
			message: undefined,
		});
	});

	it("throws the browser support message before loading Mediabunny", async () => {
		await expect(
			saveLoomStreamAsMp4({
				url: "https://cdn.loom.com/video.m3u8",
				filename: "loom.mp4",
			}),
		).rejects.toThrow("latest desktop Chrome or Edge");
	});

	it("extracts user-facing conversion errors", () => {
		const error = new LoomBrowserConversionError("Use Chrome or Edge.");

		expect(getLoomBrowserConversionErrorMessage(error)).toBe(
			"Use Chrome or Edge.",
		);
		expect(getLoomBrowserConversionErrorMessage(new Error("Internal"))).toBe(
			"Error: Internal",
		);
	});

	it("treats abort-style errors as cancellations", () => {
		const abortError =
			typeof DOMException !== "undefined"
				? new DOMException("Cancelled", "AbortError")
				: Object.assign(new Error("Cancelled"), { name: "AbortError" });

		expect(isLoomBrowserConversionAbort(abortError)).toBe(true);
		expect(
			isLoomBrowserConversionAbort(
				Object.assign(new Error("Cancelled"), {
					name: "ConversionCanceledError",
				}),
			),
		).toBe(true);
		expect(isLoomBrowserConversionAbort(new Error("Other"))).toBe(false);
	});

	it("expands Loom DASH WebM segments with inherited signed query params", () => {
		const manifest = parseLoomDashManifest(
			`<?xml version="1.0" encoding="UTF-8"?>
			<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT19.738S">
				<Period id="0">
					<AdaptationSet id="0" contentType="audio" lang="en" segmentAlignment="true">
						<Representation id="0" bandwidth="129279" codecs="opus" mimeType="audio/webm" audioSamplingRate="48000">
							<SegmentTemplate timescale="1000000" initialization="video-audio-init.webm" media="video-audio-$Number$.webm" startNumber="0">
								<SegmentTimeline>
									<S t="0" d="3989000" r="1"/>
									<S t="7978000" d="3660000"/>
								</SegmentTimeline>
							</SegmentTemplate>
						</Representation>
					</AdaptationSet>
					<AdaptationSet id="1" contentType="video" segmentAlignment="true">
						<Representation id="original" bandwidth="4293142" codecs="vp9" mimeType="video/webm" width="1920" height="1080">
							<SegmentTemplate timescale="1000000" initialization="video-init.webm" media="video-$Number$.webm" startNumber="0">
								<SegmentTimeline>
									<S t="0" d="4017000"/>
									<S t="4017000" d="3673000"/>
								</SegmentTimeline>
							</SegmentTemplate>
						</Representation>
					</AdaptationSet>
				</Period>
			</MPD>`,
			"https://luna.loom.com/id/example/resource/dash/playlistmultibitrate.mpd?Policy=abc&Signature=def",
		);

		expect(manifest.durationSeconds).toBe(19.738);
		expect(manifest.audioRepresentations).toHaveLength(1);
		expect(manifest.videoRepresentations).toHaveLength(1);
		expect(manifest.audioRepresentations[0]?.segments).toHaveLength(3);
		expect(manifest.videoRepresentations[0]).toMatchObject({
			type: "video",
			id: "original",
			bandwidth: 4293142,
			codecs: "vp9",
			mimeType: "video/webm",
			width: 1920,
			height: 1080,
			durationSeconds: 7.69,
		});
		expect(manifest.videoRepresentations[0]?.initUrl).toBe(
			"https://luna.loom.com/id/example/resource/dash/video-init.webm?Policy=abc&Signature=def",
		);
		expect(
			manifest.audioRepresentations[0]?.segments.map((s) => s.url),
		).toEqual([
			"https://luna.loom.com/id/example/resource/dash/video-audio-0.webm?Policy=abc&Signature=def",
			"https://luna.loom.com/id/example/resource/dash/video-audio-1.webm?Policy=abc&Signature=def",
			"https://luna.loom.com/id/example/resource/dash/video-audio-2.webm?Policy=abc&Signature=def",
		]);
	});
});
