import { describe, expect, it } from "vitest";
import {
	MICRO_CREDITS_PER_DOLLAR,
	SPEECH_DOLLARS_PER_HOUR,
	SPEECH_MICRO_CREDITS_PER_HOUR,
	transcriptionBilledSeconds,
	transcriptionMicroCredits,
} from "@/lib/developer-pricing";
import {
	buildTranscriptResult,
	DEVELOPER_UPLOAD_PREFIX,
	isStaleDeveloperUpload,
	isTranscriptStatus,
	measuredTranscriptDuration,
	serializeTranscript,
	type TranscriptSummaryRow,
	transcriptNameFromFile,
	transcriptNameFromUrl,
	transcriptObjectKeys,
} from "@/lib/developer-transcripts";

const row = (
	overrides: Partial<TranscriptSummaryRow & { text: string | null }> = {},
): TranscriptSummaryRow & { text?: string | null } => ({
	id: "tr-1",
	appId: "app-1",
	externalUserId: null,
	name: "Standup",
	status: "complete",
	sourceType: "upload",
	sourceUrl: null,
	s3Key: "developer/app-1/transcripts/tr-1/source",
	resultKey: "developer/app-1/transcripts/tr-1/result.json",
	sourceBytes: 1_000,
	durationSeconds: 60,
	requestedLanguage: null,
	language: "en",
	wordCount: 3,
	reservedMicroCredits: 0,
	billedMicroCredits: 166,
	errorCode: null,
	errorMessage: null,
	metadata: null,
	runId: "run-1",
	queuedAt: new Date("2026-11-11T10:00:00Z"),
	startedAt: new Date("2026-11-11T10:00:00Z"),
	completedAt: new Date("2026-11-11T10:00:20Z"),
	deletedAt: null,
	createdAt: new Date("2026-11-11T10:00:00Z"),
	updatedAt: new Date("2026-11-11T10:00:20Z"),
	text: "hello there world",
	...overrides,
});

describe("transcription price", () => {
	it("is ten cents per audio hour", () => {
		expect(SPEECH_DOLLARS_PER_HOUR).toBe(0.1);
		expect(SPEECH_MICRO_CREDITS_PER_HOUR).toBe(10_000);
		expect(transcriptionMicroCredits(3600)).toBe(10_000);
		expect(transcriptionMicroCredits(3600) / MICRO_CREDITS_PER_DOLLAR).toBe(
			0.1,
		);
	});

	it("pro-rates by the second, to the nearest second", () => {
		expect(transcriptionBilledSeconds(59.4)).toBe(59);
		expect(transcriptionBilledSeconds(59.5)).toBe(60);
		expect(transcriptionBilledSeconds(60.03)).toBe(60);
		expect(transcriptionMicroCredits(60)).toBe(166);
		expect(transcriptionMicroCredits(60.03)).toBe(166);
		expect(transcriptionMicroCredits(1800)).toBe(5_000);
		expect(transcriptionMicroCredits(5400)).toBe(15_000);
		expect(transcriptionMicroCredits(4 * 3600)).toBe(40_000);
	});

	it("never charges more than the hourly rate for the billed seconds", () => {
		for (const seconds of [1, 7, 61, 754.2, 3599, 3601, 12_345.6]) {
			const billedSeconds = transcriptionBilledSeconds(seconds);
			expect(transcriptionMicroCredits(seconds)).toBeLessThanOrEqual(
				(billedSeconds * SPEECH_MICRO_CREDITS_PER_HOUR) / 3600,
			);
		}
	});

	it("bills at least one second for any audio and nothing for none", () => {
		expect(transcriptionBilledSeconds(0.2)).toBe(1);
		expect(transcriptionMicroCredits(0.2)).toBe(2);
		expect(transcriptionMicroCredits(0.0001)).toBe(2);
		expect(transcriptionMicroCredits(0)).toBe(0);
		expect(transcriptionMicroCredits(-5)).toBe(0);
		expect(transcriptionMicroCredits(Number.NaN)).toBe(0);
		expect(transcriptionMicroCredits(Number.POSITIVE_INFINITY)).toBe(0);
	});

	it("grows with the audio length", () => {
		let previous = 0;
		for (let seconds = 1; seconds <= 7200; seconds += 37) {
			const cost = transcriptionMicroCredits(seconds);
			expect(cost).toBeGreaterThanOrEqual(previous);
			previous = cost;
		}
	});
});

describe("measured duration", () => {
	it("prefers the length measured from the extracted audio", () => {
		expect(
			measuredTranscriptDuration({
				extractedAudioSeconds: 60.03,
				serviceDurationSeconds: 61,
				lastWordEndMs: 59_000,
			}),
		).toBe(60.03);
	});

	it("falls back to the speech service, then to the last word", () => {
		expect(
			measuredTranscriptDuration({
				extractedAudioSeconds: null,
				serviceDurationSeconds: 61,
				lastWordEndMs: 59_000,
			}),
		).toBe(61);
		expect(
			measuredTranscriptDuration({
				extractedAudioSeconds: 0,
				serviceDurationSeconds: Number.NaN,
				lastWordEndMs: 59_000,
			}),
		).toBe(59);
		expect(
			measuredTranscriptDuration({
				extractedAudioSeconds: undefined,
				serviceDurationSeconds: undefined,
				lastWordEndMs: undefined,
			}),
		).toBe(0);
	});
});

describe("transcript result", () => {
	it("converts word times to seconds and groups sentences into segments", () => {
		const result = buildTranscriptResult({
			text: " Hello there. General Kenobi ",
			language: "en",
			durationSeconds: 4,
			words: [
				{ text: "Hello", start: 0, end: 400, confidence: 0.99 },
				{ text: "there.", start: 450, end: 900 },
				{ text: "General", start: 2600, end: 3000, confidence: 0.9 },
				{ text: "Kenobi", start: 3050, end: 3500, confidence: null },
			],
		});
		expect(result.text).toBe("Hello there. General Kenobi");
		expect(result.words[0]).toEqual({
			text: "Hello",
			start: 0,
			end: 0.4,
			confidence: 0.99,
		});
		expect(result.words[1]?.confidence).toBeNull();
		expect(result.segments).toEqual([
			{ text: "Hello there.", start: 0, end: 0.9 },
			{ text: "General Kenobi", start: 2.6, end: 3.5 },
		]);
	});

	it("builds text from words when the service returns none", () => {
		const result = buildTranscriptResult({
			text: null,
			language: null,
			durationSeconds: 1,
			words: [
				{ text: "one", start: 0, end: 100 },
				{ text: "two", start: 120, end: 300 },
			],
		});
		expect(result.text).toBe("one two");
		expect(result.language).toBeNull();
	});

	it("returns empty output for silence", () => {
		const result = buildTranscriptResult({
			text: "",
			language: "en",
			durationSeconds: 3,
			words: [],
		});
		expect(result).toEqual({
			text: "",
			language: "en",
			durationSeconds: 3,
			words: [],
			segments: [],
		});
	});
});

describe("transcript serialization", () => {
	it("only returns text for a complete transcript that asked for it", () => {
		expect(serializeTranscript(row())).not.toHaveProperty("text");
		expect(serializeTranscript(row(), { includeText: true }).text).toBe(
			"hello there world",
		);
		expect(
			serializeTranscript(row({ status: "processing", text: "partial" }), {
				includeText: true,
			}).text,
		).toBeNull();
	});

	it("reports cost in micro-credits and dollars", () => {
		const serialized = serializeTranscript(row({ billedMicroCredits: 10_000 }));
		expect(serialized.costMicroCredits).toBe(10_000);
		expect(serialized.costDollars).toBe(0.1);
	});

	it("exposes an error object only for failed transcripts", () => {
		expect(serializeTranscript(row()).error).toBeNull();
		expect(
			serializeTranscript(
				row({
					status: "error",
					errorCode: "insufficient_credits",
					errorMessage: "Not enough credits",
				}),
			).error,
		).toEqual({ code: "insufficient_credits", message: "Not enough credits" });
	});

	it("never exposes storage keys", () => {
		const serialized = JSON.stringify(
			serializeTranscript(row(), { includeText: true }),
		);
		expect(serialized).not.toContain("developer/app-1");
		expect(serialized).not.toContain("s3Key");
		expect(serialized).not.toContain("resultKey");
	});

	it("keeps the source URL for URL transcripts", () => {
		expect(
			serializeTranscript(
				row({ sourceType: "url", sourceUrl: "https://example.com/a.mp3" }),
			).source,
		).toEqual({ type: "url", url: "https://example.com/a.mp3" });
		expect(serializeTranscript(row()).source).toEqual({
			type: "upload",
			url: null,
		});
	});
});

describe("stale upload sweep", () => {
	const now = new Date("2026-11-11T12:00:00Z");
	const hoursAgo = (hours: number) =>
		new Date(now.getTime() - hours * 60 * 60 * 1000);

	it("removes transcript uploads after 8 hours", () => {
		const key = "developer/_uploads/app-1/t-tr-1";
		expect(isStaleDeveloperUpload(key, hoursAgo(7.9), now)).toBe(false);
		expect(isStaleDeveloperUpload(key, hoursAgo(8.1), now)).toBe(true);
	});

	it("keeps video uploads for 48 hours so a top-up can finish them", () => {
		const key = "developer/_uploads/app-1/v-video-1";
		expect(isStaleDeveloperUpload(key, hoursAgo(9), now)).toBe(false);
		expect(isStaleDeveloperUpload(key, hoursAgo(47.9), now)).toBe(false);
		expect(isStaleDeveloperUpload(key, hoursAgo(48.1), now)).toBe(true);
	});

	it("never touches anything outside the upload prefix", () => {
		for (const key of [
			"developer/app-1/transcripts/tr-1/result.json",
			"developer/app-1/video-1/video-abc",
			"user-1/video-1/result.mp4",
		]) {
			expect(isStaleDeveloperUpload(key, hoursAgo(10_000), now)).toBe(false);
		}
	});
});

describe("transcript inputs", () => {
	it("recognises transcript statuses", () => {
		expect(isTranscriptStatus("complete")).toBe(true);
		expect(isTranscriptStatus("COMPLETE")).toBe(false);
		expect(isTranscriptStatus(undefined)).toBe(false);
	});

	it("names transcripts from files and URLs", () => {
		expect(transcriptNameFromFile("standup.m4a")).toBe("standup");
		expect(transcriptNameFromFile("/tmp/calls/weekly sync.mp3")).toBe(
			"weekly sync",
		);
		expect(transcriptNameFromFile("")).toBe("Untitled");
		expect(transcriptNameFromFile(".hidden")).toBe(".hidden");
		expect(
			transcriptNameFromUrl("https://example.com/audio/talk%20one.mp3?x=1"),
		).toBe("talk one");
		expect(transcriptNameFromUrl("https://example.com/")).toBe("example.com");
		expect(transcriptNameFromUrl("not a url")).toBe("Untitled");
		expect(transcriptNameFromFile("a".repeat(400)).length).toBe(255);
	});

	it("keeps uploads apart from results and every key under its app", () => {
		const keys = transcriptObjectKeys("app-1", "tr-1");
		expect(keys.source).toBe("developer/_uploads/app-1/t-tr-1");
		expect(keys.audio).toBe("developer/app-1/transcripts/tr-1/audio.mp3");
		expect(keys.result).toBe("developer/app-1/transcripts/tr-1/result.json");
		expect(keys.source.startsWith(DEVELOPER_UPLOAD_PREFIX)).toBe(true);
		expect(keys.audio.startsWith(DEVELOPER_UPLOAD_PREFIX)).toBe(false);
		expect(keys.result.startsWith(DEVELOPER_UPLOAD_PREFIX)).toBe(false);
		expect(
			transcriptObjectKeys("app-2", "tr-1").source.includes("/app-1/"),
		).toBe(false);
	});
});
