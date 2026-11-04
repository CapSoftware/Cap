import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeAsyncAudio } from "@/lib/async-transcription";
import {
	getAsyncTranscriptionConfig,
	hasTranscriptionProvider,
} from "@/lib/transcription-provider";

const state = vi.hoisted(() => ({
	env: {} as Record<string, string | undefined>,
}));

vi.mock("@cap/env", () => ({ serverEnv: () => state.env }));

const config = {
	baseUrl: "http://asr.test",
	apiKey: "test-token",
	timeoutMs: 1_000,
};
const audio = Buffer.from("audio");
const result = {
	words: [{ text: "hello", start: 200, end: 600 }],
	audio_duration: 1,
	language_code: "en",
	speech_model_used: "test-model",
};
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status });

afterEach(() => {
	vi.unstubAllGlobals();
	state.env = {};
});

describe("async transcription provider selection", () => {
	it("keeps AssemblyAI by default and selects async without cloud fallback", () => {
		state.env = { ASSEMBLY_API_KEY: "assembly-key" };
		expect(hasTranscriptionProvider()).toBe(true);
		expect(getAsyncTranscriptionConfig()).toBeNull();
		state.env = {
			ASSEMBLY_API_KEY: "assembly-key",
			ASYNC_TRANSCRIPTION_URL: "http://asr.test",
		};
		expect(hasTranscriptionProvider()).toBe(true);
		expect(() => getAsyncTranscriptionConfig()).toThrow(
			"ASYNC_TRANSCRIPTION_API_KEY",
		);
		state.env.ASYNC_TRANSCRIPTION_API_KEY = "test-token";
		expect(getAsyncTranscriptionConfig()).toEqual(configToExpected());
	});

	it("rejects unsafe URLs and invalid timeout", () => {
		state.env = {
			ASYNC_TRANSCRIPTION_URL: "http://asr.test?token=leak",
			ASYNC_TRANSCRIPTION_API_KEY: "test-token",
		};
		expect(() => getAsyncTranscriptionConfig()).toThrow("without credentials");
		state.env.ASYNC_TRANSCRIPTION_URL = "http://asr.test";
		state.env.ASYNC_TRANSCRIPTION_TIMEOUT_SECONDS = "0";
		expect(() => getAsyncTranscriptionConfig()).toThrow("between 1 and 86400");
	});
});

function configToExpected() {
	return {
		baseUrl: "http://asr.test",
		apiKey: "test-token",
		timeoutMs: 21_600_000,
	};
}

describe("asynchronous transcription protocol", () => {
	it("uploads raw audio, polls, preserves millisecond words and cleans up", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(json({ id: "job-123" }))
			.mockResolvedValueOnce(json({ status: "queued" }))
			.mockResolvedValueOnce(json({ status: "completed", result }))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			transcribeAsyncAudio(config, audio, "audio/mpeg", 1),
		).resolves.toEqual(result);
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(fetchMock.mock.calls[0]).toEqual([
			"http://asr.test/v1/transcriptions",
			expect.objectContaining({
				method: "POST",
				body: audio,
				redirect: "error",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "audio/mpeg",
					"x-filename": "audio.mp3",
				},
			}),
		]);
		expect(fetchMock.mock.calls[3]).toEqual([
			"http://asr.test/v1/transcriptions/job-123",
			expect.objectContaining({ method: "DELETE", redirect: "error" }),
		]);
		for (const [, options] of fetchMock.mock.calls)
			expect(options.redirect).toBe("error");
	});

	it.each([
		["provider error", { status: "error" }],
		["invalid status", { status: "unknown" }],
		[
			"malformed word timings",
			{
				status: "completed",
				result: { ...result, words: [{ text: "bad", start: "zero", end: 1 }] },
			},
		],
	])("rejects %s and removes the job", async (_label, response) => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(json({ id: "job-123" }))
			.mockResolvedValueOnce(json(response))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			transcribeAsyncAudio(config, audio, "audio/mpeg"),
		).rejects.toThrow();
		expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
			method: "DELETE",
			redirect: "error",
		});
	});

	it("aborts a stalled status request at the deadline and cleans up", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(json({ id: "job-123" }))
			.mockImplementationOnce(
				(_url: string, options: RequestInit) =>
					new Promise((_resolve, reject) => {
						options.signal?.addEventListener(
							"abort",
							() => reject(new Error("aborted")),
							{ once: true },
						);
					}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			transcribeAsyncAudio({ ...config, timeoutMs: 20 }, audio, "audio/mpeg"),
		).rejects.toThrow("aborted");
		expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
			method: "DELETE",
			redirect: "error",
		});
	});

	it("fails creation without trying an unknown job URL", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(json({ id: "../secret" }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			transcribeAsyncAudio(config, audio, "audio/mpeg"),
		).rejects.toThrow("invalid job id");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
