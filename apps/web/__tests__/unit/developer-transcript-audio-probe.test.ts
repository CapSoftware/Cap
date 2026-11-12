import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		MEDIA_SERVER_URL: "http://media.test",
		MEDIA_SERVER_WEBHOOK_SECRET: "secret",
	}),
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	NODE_ENV: "test",
}));

import {
	extractTranscriptAudioBytes,
	probeShowsNoAudio,
} from "@/lib/developer-transcript-audio";

const calls = { probe: 0, convert: 0, check: 0 };
let probe: () => Response;
let convert: () => Response;

const probed = (metadata: Record<string, unknown>) => () =>
	Response.json({ metadata });

beforeEach(() => {
	calls.probe = 0;
	calls.convert = 0;
	calls.check = 0;
	probe = () => new Response("{}", { status: 422 });
	convert = () => new Response(new Uint8Array(1_000), { status: 200 });
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === "http://media.test/video/probe") {
			calls.probe += 1;
			return probe();
		}
		if (url === "http://media.test/audio/convert") {
			calls.convert += 1;
			return convert();
		}
		if (url === "http://media.test/audio/check") {
			calls.check += 1;
			return Response.json({ hasAudio: false });
		}
		throw new Error(`Unexpected fetch ${url}`);
	});
});

afterEach(() => vi.unstubAllGlobals());

describe("a file with no audio track", () => {
	it("is reported from the probe, without trying to convert it", async () => {
		probe = probed({
			duration: 8,
			width: 1280,
			height: 720,
			audioCodec: null,
			audioChannels: null,
			sampleRate: null,
		});
		convert = () => new Response(null, { status: 503 });
		const started = Date.now();

		const result = await extractTranscriptAudioBytes("http://storage.test/a");

		expect(result).toEqual({ state: "no_audio" });
		expect(calls).toEqual({ probe: 1, convert: 0, check: 0 });
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("converts straight away when the probe sees an audio track, with no extra call", async () => {
		probe = probed({
			duration: 8,
			width: 1280,
			height: 720,
			audioCodec: "aac",
		});

		const result = await extractTranscriptAudioBytes("http://storage.test/a");

		expect(result.state).toBe("ok");
		expect(calls).toEqual({ probe: 1, convert: 1, check: 0 });
	});

	it("converts audio whose codec the probe cannot name but whose channels it sees", async () => {
		probe = probed({
			duration: 8,
			width: 1280,
			height: 720,
			audioCodec: null,
			audioChannels: 2,
			sampleRate: 44_100,
		});

		const result = await extractTranscriptAudioBytes("http://storage.test/a");

		expect(result.state).toBe("ok");
		expect(calls).toEqual({ probe: 1, convert: 1, check: 0 });
	});

	it("follows the media server's own rule for whether a source has audio", () => {
		expect(probeShowsNoAudio({ audioCodec: null, audioChannels: null })).toBe(
			true,
		);
		expect(probeShowsNoAudio({ audioCodec: "", audioChannels: null })).toBe(
			true,
		);
		expect(probeShowsNoAudio({ audioCodec: null, audioChannels: 2 })).toBe(
			false,
		);
		expect(probeShowsNoAudio({ audioCodec: null, audioChannels: 6 })).toBe(
			false,
		);
		expect(probeShowsNoAudio({ audioCodec: "opus", audioChannels: null })).toBe(
			false,
		);
		expect(probeShowsNoAudio({ audioCodec: "aac", audioChannels: 2 })).toBe(
			false,
		);
		expect(probeShowsNoAudio({ audioCodec: null })).toBe(false);
		expect(probeShowsNoAudio({})).toBe(false);
	});

	it("converts an audio-only file the probe cannot read, with no extra call", async () => {
		const result = await extractTranscriptAudioBytes("http://storage.test/a");

		expect(result.state).toBe("ok");
		expect(calls).toEqual({ probe: 1, convert: 1, check: 0 });
	});

	it("converts when an older probe answer does not say whether there is audio", async () => {
		probe = probed({ duration: 8, width: 1280, height: 720 });

		const result = await extractTranscriptAudioBytes("http://storage.test/a");

		expect(result.state).toBe("ok");
		expect(calls).toEqual({ probe: 1, convert: 1, check: 0 });
	});
});
