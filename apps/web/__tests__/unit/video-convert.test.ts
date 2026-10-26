import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ffmpeg-static", () => ({
	default: "/usr/local/bin/ffmpeg",
}));

const mockReadFile = vi.fn(async (_path: string) => Buffer.from("video-data"));
const mockMkdtemp = vi.fn(async (_prefix: string) => "/tmp/cap-video-test");
const mockWriteFile = vi.fn(
	async (_path: string, _content: string) => undefined,
);
const mockRm = vi.fn(async (_path: string) => undefined);

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (path: string) => path === "/usr/local/bin/ffmpeg",
		promises: {
			...actual.promises,
			mkdtemp: (prefix: string) => mockMkdtemp(prefix),
			readFile: (path: string) => mockReadFile(path),
			rm: (path: string) => mockRm(path),
			writeFile: (path: string, content: string) =>
				mockWriteFile(path, content),
		},
	};
});

class MockChildProcess extends EventEmitter {
	stderr = new EventEmitter();
}

let spawnedProcesses: MockChildProcess[] = [];
let spawnArgs: { command: string; args: string[] }[] = [];

vi.mock("node:child_process", () => ({
	spawn: (command: string, args: string[]) => {
		const proc = new MockChildProcess();
		spawnedProcesses.push(proc);
		spawnArgs.push({ command, args });
		return proc;
	},
}));

describe("video-convert", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		spawnedProcesses = [];
		spawnArgs = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = input.toString();

				if (url.includes("video.m3u8")) {
					return {
						ok: true,
						text: async () =>
							'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000,AUDIO="audio"\nmedia-video.m3u8\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",DEFAULT="YES",URI="media-audio.m3u8"',
					} as Response;
				}

				if (url.includes("media-video.m3u8")) {
					return {
						ok: true,
						text: async () => "#EXTM3U\n#EXTINF:1,\nsegment-video.ts",
					} as Response;
				}

				if (url.includes("media-audio.m3u8")) {
					return {
						ok: true,
						text: async () => "#EXTM3U\n#EXTINF:1,\nsegment-audio.aac",
					} as Response;
				}

				throw new Error(`Unexpected fetch: ${url}`);
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it("uses stream copy before transcoding", async () => {
		const { convertRemoteVideoToMp4Buffer } = await import(
			"@/lib/video-convert"
		);

		const resultPromise = convertRemoteVideoToMp4Buffer(
			"https://example.com/video.m3u8",
		);

		setTimeout(() => {
			spawnedProcesses[0]?.emit("close", 0);
		}, 10);

		const result = await resultPromise;

		expect(result.toString()).toBe("video-data");
		expect(spawnArgs).toHaveLength(1);
		expect(spawnArgs[0]?.args).toContain("-c");
		expect(spawnArgs[0]?.args).toContain("copy");
		expect(mockWriteFile).toHaveBeenCalled();
	});

	it("inherits signed media queries only on the playlist origin", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				text: async () =>
					'#EXTM3U\\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/key"\\n#EXTINF:1,\\nchunk.ts\\n#EXTINF:1,\\nhttps://cdn.other.example/external.ts\\n#EXTINF:1,\\n//cdn.other.example/another.ts?token=own',
			})),
		);
		const { convertRemoteVideoToMp4Buffer } = await import(
			"@/lib/video-convert"
		);
		const resultPromise = convertRemoteVideoToMp4Buffer(
			"https://media.example/video.m3u8?Policy=secret&Signature=sig",
		);
		setTimeout(() => spawnedProcesses[0]?.emit("close", 0), 10);
		await resultPromise;
		const playlist = mockWriteFile.mock.calls[0]?.[1];
		expect(playlist).toContain(
			"https://media.example/chunk.ts?Policy=secret&Signature=sig",
		);
		expect(playlist).toContain('URI="https://keys.example/key"');
		expect(playlist).toContain("https://cdn.other.example/external.ts");
		expect(playlist).toContain(
			"https://cdn.other.example/another.ts?token=own",
		);
		expect(playlist).not.toContain("keys.example/key?Policy");
		expect(playlist).not.toContain("external.ts?Policy");
	});

	it("falls back to transcoding when stream copy fails", async () => {
		const { convertRemoteVideoToMp4Buffer } = await import(
			"@/lib/video-convert"
		);

		const resultPromise = convertRemoteVideoToMp4Buffer(
			"https://example.com/video.m3u8",
		);

		setTimeout(() => {
			spawnedProcesses[0]?.stderr.emit("data", Buffer.from("copy failed"));
			spawnedProcesses[0]?.emit("close", 1);
			setTimeout(() => {
				spawnedProcesses[1]?.emit("close", 0);
			}, 10);
		}, 10);

		await resultPromise;

		expect(spawnArgs).toHaveLength(2);
		expect(spawnArgs[1]?.args).toContain("libx264");
		expect(spawnArgs[1]?.args).toContain("aac");
	});
});
