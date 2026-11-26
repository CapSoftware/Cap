import { describe, expect, it } from "vitest";
import {
	isNonVideoContentType,
	isNonVideoFileName,
	SUPPORTED_VIDEO_FORMATS,
	UNREADABLE_VIDEO_REASON,
} from "../src/files";
import { createHostedTools } from "../src/hosted";
import type { InfraClient } from "../src/http";
import { CAPTIONS_NEXT, transcriptView, videoDetail } from "../src/shape";
import type { Tool, ToolCall } from "../src/tool";
import { createTools } from "../src/tools";
import { DEFAULT_UPLOAD_TUNING } from "../src/upload";
import { DEFAULT_WAIT_TUNING } from "../src/wait";
import { connect } from "./harness";
import { startStubApi } from "./stub-api";

const CONSOLE = "https://cap.test/dashboard/infra";

const call: ToolCall = {
	signal: new AbortController().signal,
	wantsProgress: false,
	progress: () => {},
	announce: () => {},
};

function toolsAnswering(
	answers: Record<string, unknown>,
	surface: "local" | "hosted" = "local",
) {
	const client = {
		call: async (operation: string) => ({ data: answers[operation] }),
	} as unknown as InfraClient;
	const tools = createTools({
		config: {
			secretKey: "csk_test",
			apiUrl: "https://cap.test",
			consoleUrl: CONSOLE,
		},
		client,
		upload: DEFAULT_UPLOAD_TUNING,
		wait: { ...DEFAULT_WAIT_TUNING, pollIntervalMs: 1, maxPollIntervalMs: 1 },
		surface,
	});
	return (name: string) => tools.find((entry) => entry.name === name) as Tool;
}

const completeFromVideo = {
	id: "tr_1",
	status: "complete",
	videoId: "video-1",
	wordCount: 12,
	source: { type: "video", url: null },
	text: "Hello",
};

describe("strict tool arguments on the stdio server", () => {
	it("publishes additionalProperties false for every tool and refuses unknown keys by name", async () => {
		const stub = await startStubApi();
		const session = await connect(stub);
		try {
			const { tools } = await session.client.listTools();
			expect(tools.length).toBeGreaterThan(10);
			for (const listed of tools) {
				expect(listed.inputSchema, listed.name).toMatchObject({
					additionalProperties: false,
				});
			}

			const refused = await session.client.callTool({
				name: "videos_get",
				arguments: { videoId: "video-1", videoID: "video-1" },
			});
			expect(refused.isError).toBe(true);
			const text = (refused.content as { text: string }[])[0]?.text ?? "";
			expect(text).toContain('Unrecognized key: "videoID"');
			expect(text).toContain("This tool accepts videoId and userId.");
			expect(stub.requests).toHaveLength(0);

			const usage = await session.client.callTool({
				name: "account_usage",
				arguments: { verbose: true },
			});
			expect(usage.isError).toBe(true);
			expect((usage.content as { text: string }[])[0]?.text).toContain(
				"This tool accepts no arguments.",
			);
		} finally {
			await session.close();
			await stub.close();
		}
	});

	it("gives the hosted tools the same strict schemas", () => {
		for (const hosted of createHostedTools({
			apiUrl: "https://cap.test",
			secretKey: "csk_test",
			fetch,
			log: () => {},
		})) {
			expect(hosted.inputSchema.safeParse({ extra: 1 }).success).toBe(false);
		}
	});
});

describe("transcript results", () => {
	it("carries the videoId a transcript was made from", () => {
		expect(transcriptView(completeFromVideo, CONSOLE)).toMatchObject({
			id: "tr_1",
			videoId: "video-1",
		});
		expect(
			transcriptView({ id: "tr_2", videoId: null, status: "queued" }, CONSOLE),
		).toMatchObject({ videoId: null });
	});

	it("tells the agent the video now has captions once a transcript from it completes", async () => {
		const tool = toolsAnswering({ getTranscript: completeFromVideo });
		const waited = (await tool("transcripts_wait").run(
			{ transcriptId: "tr_1" },
			call,
		)) as Record<string, unknown>;
		expect(waited.next).toBe(CAPTIONS_NEXT);
		const got = (await tool("transcripts_get").run(
			{ transcriptId: "tr_1" },
			call,
		)) as Record<string, unknown>;
		expect(got.next).toBe(CAPTIONS_NEXT);
	});

	it.each([
		["from a url", { ...completeFromVideo, videoId: null }],
		["with no speech", { ...completeFromVideo, wordCount: 0 }],
		["that failed", { ...completeFromVideo, status: "error" }],
	])(
		"says nothing about captions for a transcript %s",
		async (_label, found) => {
			const tool = toolsAnswering({ getTranscript: found });
			const got = (await tool("transcripts_get").run(
				{ transcriptId: "tr_1" },
				call,
			)) as Record<string, unknown>;
			expect(got.next).toBeUndefined();
		},
	);

	it("gives transcripts_text a next step while the transcript is still running", async () => {
		const running = toolsAnswering({
			getTranscript: { id: "tr_1", status: "processing" },
		});
		expect(
			await running("transcripts_text").run({ transcriptId: "tr_1" }, call),
		).toMatchObject({
			status: "processing",
			text: null,
			next: expect.stringContaining("transcripts_wait"),
		});
		const done = toolsAnswering({ getTranscript: completeFromVideo });
		expect(
			await done("transcripts_text").run({ transcriptId: "tr_1" }, call),
		).not.toHaveProperty("next");
	});

	it("names the accepted sources, with a status, when none or two are sent", async () => {
		for (const surface of ["local", "hosted"] as const) {
			const tool = toolsAnswering({}, surface);
			await expect(
				tool("transcripts_create").run({}, call),
			).rejects.toMatchObject({
				code: "invalid_source",
				status: 400,
				hint: expect.stringContaining("Send only one of them."),
			});
		}
	});
});

describe("video and account results", () => {
	it("lists a video's captions in videos_get", () => {
		const captions = [{ language: "en", url: "https://cap.test/c/en.vtt" }];
		expect(videoDetail({ id: "video-1", captions })).toMatchObject({
			captions,
		});
		expect(videoDetail({ id: "video-1" })).not.toHaveProperty("captions");
	});

	it("rounds the stored minutes in account_usage to two places", async () => {
		const tool = toolsAnswering({
			getUsage: { totalDurationMinutes: 0.19499999682108562, totalVideos: 1 },
		});
		expect(await tool("account_usage").run({}, call)).toMatchObject({
			totalDurationMinutes: 0.19,
			totalVideos: 1,
		});
	});
});

describe("non-video uploads", () => {
	it("uses the farm's reason", () => {
		expect(UNREADABLE_VIDEO_REASON).toBe(
			`This file could not be read as a video. Upload ${SUPPORTED_VIDEO_FORMATS}.`,
		);
	});

	it.each([
		"text/plain",
		"Text/Plain; charset=utf-8",
		"image/png",
		"audio/mpeg",
		"application/json",
		"application/pdf",
	])("refuses the content type %s", (contentType) => {
		expect(isNonVideoContentType(contentType)).toBe(true);
	});

	it.each([
		undefined,
		"",
		"application/octet-stream",
		"video/mp4",
		"video/quicktime",
		"video/x-matroska",
		"video/webm",
		"application/x-unknown",
	])("never refuses the content type %s", (contentType) => {
		expect(isNonVideoContentType(contentType)).toBe(false);
	});

	it.each(["notes.txt", "deck.PDF", "cover.png", "voice.m4a", "data.json"])(
		"refuses the file name %s",
		(fileName) => {
			expect(isNonVideoFileName(fileName)).toBe(true);
		},
	);

	it.each([
		undefined,
		"talk.mp4",
		"talk.MOV",
		"talk.mkv",
		"talk.webm",
		"talk.ts",
		"recording",
		"capture.unknownext",
	])("never refuses the file name %s", (fileName) => {
		expect(isNonVideoFileName(fileName)).toBe(false);
	});
});
