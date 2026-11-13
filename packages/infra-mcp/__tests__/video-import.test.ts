import { describe, expect, it, vi } from "vitest";
import { createHostedTools } from "../src/hosted";
import type { InfraClient } from "../src/http";
import type { Tool, ToolCall } from "../src/tool";
import { createTools } from "../src/tools";
import { DEFAULT_UPLOAD_TUNING } from "../src/upload";
import { DEFAULT_WAIT_TUNING } from "../src/wait";

const call: ToolCall = {
	signal: new AbortController().signal,
	wantsProgress: false,
	progress: () => {},
	announce: () => {},
};

const downloading = {
	sourceUrl: "https://media.example.com/a.mp4",
	state: "downloading",
	errorCode: null,
};

function toolsWith(
	client: { call: (operation: string, options: unknown) => Promise<unknown> },
	surface: "local" | "hosted",
) {
	const tools = createTools({
		config: {
			secretKey: "csk_test",
			apiUrl: "https://cap.test",
			consoleUrl: "https://cap.test/dashboard/infra",
		},
		client: client as unknown as InfraClient,
		upload: DEFAULT_UPLOAD_TUNING,
		wait: {
			...DEFAULT_WAIT_TUNING,
			pollIntervalMs: 1,
			maxPollIntervalMs: 1,
			outputGraceMs: 1,
		},
		surface,
	});
	return {
		names: tools.map((entry) => entry.name),
		tool: (name: string) => tools.find((entry) => entry.name === name) as Tool,
	};
}

describe("videos_import", () => {
	it("is served by the hosted endpoint, and not yet by the stdio package", () => {
		const client = { call: vi.fn() };
		expect(toolsWith(client, "hosted").names).toContain("videos_import");
		expect(toolsWith(client, "local").names).not.toContain("videos_import");
		expect(
			createHostedTools({
				apiUrl: "https://cap.test",
				secretKey: "csk_test",
				fetch,
				log: () => {},
			}).map((entry) => entry.name),
		).toContain("videos_import");
	});

	it("refuses fields the REST call does not take, such as a local path", () => {
		const hosted = createHostedTools({
			apiUrl: "https://cap.test",
			secretKey: "csk_test",
			fetch,
			log: () => {},
		}).find((entry) => entry.name === "videos_import");
		expect(
			hosted?.inputSchema.safeParse({ url: "https://media.example.com/a.mp4" })
				.success,
		).toBe(true);
		for (const extra of [{ path: "/tmp/a.mp4" }, { contentLength: 10 }]) {
			expect(
				hosted?.inputSchema.safeParse({
					url: "https://media.example.com/a.mp4",
					...extra,
				}).success,
			).toBe(false);
		}
		expect(hosted?.inputSchema.safeParse({}).success).toBe(false);
	});

	it("sends the URL and options to importVideo, with the key as a header", async () => {
		const client = {
			call: vi.fn(async () => ({
				data: {
					id: "video-1",
					status: "uploading",
					playbackId: "p1",
					shareUrl: "https://cap.test/dev/p1",
					embedUrl: "https://cap.test/embed/p1",
					import: downloading,
				},
			})),
		};
		const result = (await toolsWith(client, "hosted").tool("videos_import").run(
			{
				url: "https://media.example.com/a.mp4",
				name: "Launch",
				maxResolutionTier: "1440p",
				idempotencyKey: "import-key-1",
			},
			call,
		)) as Record<string, unknown>;
		expect(client.call).toHaveBeenCalledWith("importVideo", {
			body: {
				url: "https://media.example.com/a.mp4",
				name: "Launch",
				maxResolutionTier: "1440p",
			},
			headers: { "Idempotency-Key": "import-key-1" },
			signal: call.signal,
		});
		expect(result).toMatchObject({
			videoId: "video-1",
			status: "uploading",
			import: downloading,
			shareUrl: "https://cap.test/dev/p1",
			next: expect.stringContaining("videos_wait"),
		});
	});
});

describe("videos_wait on an imported video", () => {
	it("keeps waiting while the file downloads, then while it encodes", async () => {
		const replies = [
			{ id: "video-1", status: "uploading", import: downloading },
			{ id: "video-1", status: "uploading", import: downloading },
			{
				id: "video-1",
				status: "processing",
				import: { ...downloading, state: "complete" },
			},
			{
				id: "video-1",
				status: "ready",
				ready: true,
				playbackId: "p1",
				hlsUrl: "https://cap.test/h.m3u8",
				mp4Url: "https://cap.test/v.mp4",
				import: { ...downloading, state: "complete" },
			},
		];
		const client = {
			call: vi.fn(async () => ({ data: replies.shift() })),
		};
		const result = (await toolsWith(client, "hosted")
			.tool("videos_wait")
			.run({ videoId: "video-1" }, call)) as Record<string, unknown>;
		expect(client.call).toHaveBeenCalledTimes(4);
		expect(result).toMatchObject({
			status: "ready",
			hlsUrl: "https://cap.test/h.m3u8",
			import: { state: "complete" },
		});
		expect(result.next).toBeUndefined();
	});

	it("keeps a signed source link's query out of the result", async () => {
		const client = {
			call: vi.fn(async () => ({
				data: {
					id: "video-1",
					status: "errored",
					import: {
						sourceUrl:
							"https://bucket.example.com/a.mp4?X-Amz-Signature=secret#t=1",
						state: "failed",
						errorCode: "timeout",
					},
				},
			})),
		};
		const tools = toolsWith(client, "hosted");
		for (const [name, args] of [
			["videos_wait", { videoId: "video-1" }],
			["videos_get", { videoId: "video-1" }],
		] as const) {
			const result = await tools.tool(name).run(args, call);
			expect(JSON.stringify(result), name).not.toContain("secret");
			expect(result, name).toMatchObject({
				import: { sourceUrl: "https://bucket.example.com/a.mp4" },
			});
		}
	});

	it("stops on a failed import with its reason", async () => {
		const client = {
			call: vi.fn(async () => ({
				data: {
					id: "video-1",
					status: "errored",
					errorReason: "Import failed: The URL answered 404",
					import: {
						...downloading,
						state: "failed",
						errorCode: "url_unreachable",
					},
				},
			})),
		};
		const result = (await toolsWith(client, "hosted")
			.tool("videos_wait")
			.run({ videoId: "video-1" }, call)) as Record<string, unknown>;
		expect(result).toMatchObject({
			status: "errored",
			errorReason: "Import failed: The URL answered 404",
			import: { errorCode: "url_unreachable" },
		});
	});

	it("still treats an upload with no file as final", async () => {
		const client = {
			call: vi.fn(async () => ({
				data: { id: "video-1", status: "uploading" },
			})),
		};
		const result = (await toolsWith(client, "hosted")
			.tool("videos_wait")
			.run({ videoId: "video-1" }, call)) as Record<string, unknown>;
		expect(client.call).toHaveBeenCalledTimes(1);
		expect(result.next).toContain("videos_create_upload");
		expect(result).not.toHaveProperty("import");
	});
});
