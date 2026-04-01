import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ffmpeg-static", () => ({
	default: "/usr/local/bin/ffmpeg",
}));

const mockReadFile = vi.fn(async (_path: string) => Buffer.from("video-data"));
const mockUnlink = vi.fn(async (_path: string) => undefined);

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (path: string) => path === "/usr/local/bin/ffmpeg",
		promises: {
			...actual.promises,
			readFile: (path: string) => mockReadFile(path),
			unlink: (path: string) => mockUnlink(path),
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
	});

	afterEach(() => {
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
