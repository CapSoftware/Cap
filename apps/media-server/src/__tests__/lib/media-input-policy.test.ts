import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJob, updateJob } from "../../lib/job-manager";
import {
	assertMediaFileContent,
	getSafeDemuxerWhitelist,
	INPUT_POLICY_VIOLATION,
	isInputPolicyViolationMessage,
	isTrustedStreamingUrl,
	looksLikeTextContainer,
	MediaInputPolicyError,
	parseSafeDemuxers,
	trustLocalPlaylist,
} from "../../lib/media-input-policy";
import {
	childProcessEnv,
	hardenMediaCommand,
	spawn,
} from "../../lib/media-spawn";
import {
	downloadVideoToTemp,
	materializeStreamingInput,
	normalizeVideoInputExtension,
} from "../../lib/media-video";

const encoder = new TextEncoder();
const WHITELIST = getSafeDemuxerWhitelist();

function inputOptions(cmd: string[], input: string): string[] {
	const end = cmd.indexOf(input) - 1;
	const previous = cmd.lastIndexOf("-i", end - 1);
	return cmd.slice(previous === -1 ? 1 : previous + 2, end);
}

describe("demuxer whitelist", () => {
	test("drops demuxers that open nested resources, devices and header lines", () => {
		const listing = [
			"Formats:",
			" D.. = Demuxing supported",
			" ..d = Is a device",
			" ---",
			" D   concat          Virtual concatenation script",
			" D   dash            Dynamic Adaptive Streaming over HTTP",
			" D   hls             Apple HTTP Live Streaming",
			" D   imf             IMF (Interoperable Master Format)",
			" D d lavfi           Libavfilter virtual input device",
			" D   matroska,webm   Matroska / WebM",
			" D   mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV",
			" DE  mpegts          MPEG-TS (MPEG-2 Transport Stream)",
			" D   sdp             SDP",
			"  E  mp4             MP4 (MPEG-4 Part 14)",
		].join("\n");
		expect(parseSafeDemuxers(listing)).toEqual([
			"matroska,webm",
			"mov,mp4,m4a,3gp,3g2,mj2",
			"mpegts",
		]);
	});

	test("the installed FFmpeg keeps common containers and excludes playlists", () => {
		const names = new Set(WHITELIST.split(","));
		for (const name of ["mov", "mp4", "matroska", "webm", "mpegts", "mp3"])
			expect(names.has(name)).toBe(true);
		for (const name of ["hls", "dash", "concat", "imf", "sdp", "lavfi"])
			expect(names.has(name)).toBe(false);
	});
});

describe("hardenMediaCommand", () => {
	test("local, remote and pipe inputs get matching protocol and format whitelists", () => {
		const cmd = hardenMediaCommand([
			"ffmpeg",
			"-y",
			"-i",
			"/tmp/a.mp4",
			"-ss",
			"2",
			"-i",
			"https://bucket.example/b.webm?sig=1",
			"-f",
			"s16le",
			"-i",
			"pipe:0",
			"-c",
			"copy",
			"/tmp/out.mp4",
		]);
		expect(inputOptions(cmd, "/tmp/a.mp4")).toEqual([
			"-y",
			"-protocol_whitelist",
			"file",
			"-format_whitelist",
			WHITELIST,
		]);
		expect(inputOptions(cmd, "https://bucket.example/b.webm?sig=1")).toEqual([
			"-ss",
			"2",
			"-protocol_whitelist",
			"http,https,tcp,tls",
			"-format_whitelist",
			WHITELIST,
		]);
		expect(inputOptions(cmd, "pipe:0")).toEqual([
			"-f",
			"s16le",
			"-protocol_whitelist",
			"pipe",
		]);
		expect(cmd.at(-1)).toBe("/tmp/out.mp4");
	});

	test("keeps explicit whitelists, forced formats and generated sources", () => {
		const original = [
			"ffmpeg",
			"-f",
			"lavfi",
			"-i",
			"anullsrc",
			"-protocol_whitelist",
			"file,concat",
			"-f",
			"mov",
			"-i",
			"concat:/tmp/init.mp4|/tmp/seg.m4s",
			"-f",
			"null",
			"-",
		];
		expect(hardenMediaCommand(original)).toEqual(original);
	});

	test("unknown schemes are limited to local files", () => {
		const cmd = hardenMediaCommand([
			"ffmpeg",
			"-i",
			"data:text/plain,x",
			"o.mp4",
		]);
		expect(inputOptions(cmd, "data:text/plain,x")).toEqual([
			"-protocol_whitelist",
			"file",
			"-format_whitelist",
			WHITELIST,
		]);
	});

	test("trusted local playlists keep their playlist demuxer", () => {
		trustLocalPlaylist("/tmp/stream-x/master.m3u8");
		const cmd = hardenMediaCommand([
			"ffmpeg",
			"-i",
			"/tmp/stream-x/master.m3u8",
			"out.mkv",
		]);
		expect(inputOptions(cmd, "/tmp/stream-x/master.m3u8")).toEqual([
			"-protocol_whitelist",
			"file",
		]);
	});

	test("ffprobe gets global whitelists for its input", () => {
		expect(
			hardenMediaCommand([
				"ffprobe",
				"-v",
				"error",
				"https://bucket.example/x.mp4",
			]),
		).toEqual([
			"ffprobe",
			"-protocol_whitelist",
			"http,https,tcp,tls",
			"-format_whitelist",
			WHITELIST,
			"-v",
			"error",
			"https://bucket.example/x.mp4",
		]);
		expect(
			hardenMediaCommand(["ffprobe", "-f", "mov", "-i", "/tmp/x.mp4"]),
		).toEqual([
			"ffprobe",
			"-protocol_whitelist",
			"file",
			"-f",
			"mov",
			"-i",
			"/tmp/x.mp4",
		]);
	});

	test("other commands are unchanged", () => {
		expect(hardenMediaCommand(["nvidia-smi", "-L"])).toEqual([
			"nvidia-smi",
			"-L",
		]);
	});
});

test("child processes do not inherit credentials", () => {
	expect(
		childProcessEnv({
			PATH: "/usr/bin",
			NVIDIA_VISIBLE_DEVICES: "all",
			LD_LIBRARY_PATH: "/usr/local/nvidia/lib64",
			MEDIA_SERVER_WEBHOOK_SECRET: "s",
			AWS_SECRET_ACCESS_KEY: "s",
			AWS_REGION: "us-east-1",
			DATABASE_URL: "mysql://x",
			SOME_API_KEY: "s",
			GITHUB_TOKEN: "s",
			EMPTY: undefined,
		}),
	).toEqual({
		PATH: "/usr/bin",
		NVIDIA_VISIBLE_DEVICES: "all",
		LD_LIBRARY_PATH: "/usr/local/nvidia/lib64",
	});
});

describe("content checks", () => {
	test("detects playlists and resource lists", () => {
		for (const text of [
			"#EXTM3U\n#EXTINF:1,\nhttp://127.0.0.1/a.ts\n",
			"﻿  #EXTM3U\n",
			"ffconcat version 1.0\nfile /etc/hostname\n",
			"concat:/tmp/a|/tmp/b",
			"file:///etc/hostname",
			'<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">',
			"<MPD>",
			'<?xml version="1.0"?><CompositionPlaylist>',
			"v=0\no=- 0 0 IN IP4 127.0.0.1\n",
		])
			expect(looksLikeTextContainer(encoder.encode(text))).toBe(true);
	});

	test("accepts media containers", () => {
		const mp4 = new Uint8Array([0, 0, 0, 0x20, ...encoder.encode("ftypisom")]);
		const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86]);
		const mp3 = encoder.encode("ID3\u0004\u0000");
		for (const head of [mp4, webm, mp3, new Uint8Array()])
			expect(looksLikeTextContainer(head)).toBe(false);
	});

	test("classifies rejections", () => {
		expect(
			isInputPolicyViolationMessage(new MediaInputPolicyError("x").message),
		).toBe(true);
		expect(
			isInputPolicyViolationMessage(
				"FFmpeg exited with code 1. Last stderr: [concat @ 0x55] Format not on whitelist 'mov'",
			),
		).toBe(true);
		expect(
			isInputPolicyViolationMessage(
				"[http @ 0x1] Protocol 'file' not on whitelist 'http,https,tcp,tls'!",
			),
		).toBe(true);
		expect(
			isInputPolicyViolationMessage(
				"FFmpeg exited with code 1. Last stderr: moov atom not found",
			),
		).toBe(false);
		expect(isInputPolicyViolationMessage(undefined)).toBe(false);
	});
});

test("streaming sources must come from trusted hosts", () => {
	const hosts = ["loom.com"];
	expect(isTrustedStreamingUrl("https://cdn.loom.com/a.m3u8", hosts)).toBe(
		true,
	);
	expect(isTrustedStreamingUrl("https://loom.com/a.m3u8", hosts)).toBe(true);
	expect(isTrustedStreamingUrl("http://loom.com/a.m3u8", hosts)).toBe(true);
	expect(isTrustedStreamingUrl("http://cdn.loom.com/a.m3u8", hosts)).toBe(
		false,
	);
	expect(isTrustedStreamingUrl("https://evilloom.com/a.m3u8", hosts)).toBe(
		false,
	);
	expect(
		isTrustedStreamingUrl("https://loom.com.example.net/a.m3u8", hosts),
	).toBe(false);
	expect(isTrustedStreamingUrl("https://u:p@cdn.loom.com/a.m3u8", hosts)).toBe(
		false,
	);
	expect(isTrustedStreamingUrl("file:///tmp/a.m3u8", hosts)).toBe(false);
});

test("input extensions are limited to media files", () => {
	expect(normalizeVideoInputExtension(".webm")).toBe(".webm");
	expect(normalizeVideoInputExtension("MOV")).toBe(".mov");
	for (const extension of [".m3u8", ".mpd", ".txt", ".ffconcat", "x/y"])
		expect(normalizeVideoInputExtension(extension)).toBe(".mp4");
});

test("rejected inputs are reported with the policy error code", () => {
	const job = createJob(`policy-${Date.now()}`, "video", "user");
	updateJob(job.jobId, {
		phase: "error",
		error: new MediaInputPolicyError("not a media file").message,
	});
	expect(job.errorCode).toBe(INPUT_POLICY_VIOLATION);

	const other = createJob(`policy-other-${Date.now()}`, "video", "user");
	updateJob(other.jobId, { phase: "error", error: "moov atom not found" });
	expect(other.errorCode).toBeUndefined();
});

describe("with FFmpeg and a local server", () => {
	let dir: string;
	let server: ReturnType<typeof Bun.serve>;
	const requested: string[] = [];

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "media-input-policy-"));
		const sample = join(dir, "sample.mp4");
		const make = Bun.spawnSync([
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc=d=1:s=64x64:r=10",
			"-c:v",
			"mpeg4",
			"-y",
			sample,
		]);
		expect(make.exitCode).toBe(0);
		server = Bun.serve({
			port: 0,
			fetch(request) {
				const { pathname } = new URL(request.url);
				requested.push(pathname);
				if (pathname === "/playlist.mp4")
					return new Response(
						`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${server.port}/internal.ts\n#EXT-X-ENDLIST\n`,
						{ headers: { "content-type": "application/vnd.apple.mpegurl" } },
					);
				if (pathname === "/sample.mp4") return new Response(Bun.file(sample));
				return new Response("not found", { status: 404 });
			},
		});
	});

	afterAll(async () => {
		server.stop(true);
		await rm(dir, { recursive: true, force: true });
	});

	async function probe(input: string) {
		const proc = spawn({
			cmd: [
				"ffprobe",
				"-v",
				"error",
				"-show_entries",
				"format=format_name",
				"-of",
				"csv=p=0",
				input,
			],
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout: stdout.trim(), stderr, code };
	}

	test("real media still probes", async () => {
		const local = await probe(join(dir, "sample.mp4"));
		expect(local.code).toBe(0);
		expect(local.stdout).toContain("mp4");
		const remote = await probe(`http://127.0.0.1:${server.port}/sample.mp4`);
		expect(remote.code).toBe(0);
	});

	test("a remote playlist served as a video never reaches its segments", async () => {
		requested.length = 0;
		const result = await probe(`http://127.0.0.1:${server.port}/playlist.mp4`);
		expect(result.code).not.toBe(0);
		expect(isInputPolicyViolationMessage(result.stderr)).toBe(true);
		expect(requested).not.toContain("/internal.ts");
	});

	test("a local concat list cannot read other files", async () => {
		const list = join(dir, "list.mp4");
		await writeFile(
			list,
			`ffconcat version 1.0\nfile ${join(dir, "sample.mp4")}\n`,
		);
		const result = await probe(list);
		expect(result.code).not.toBe(0);
		expect(isInputPolicyViolationMessage(result.stderr)).toBe(true);
	});

	test("downloads that turn out to be playlists are rejected", async () => {
		await expect(
			downloadVideoToTemp(`http://127.0.0.1:${server.port}/playlist.mp4`),
		).rejects.toBeInstanceOf(MediaInputPolicyError);
		const playlist = join(dir, "local.mp4");
		await writeFile(playlist, "#EXTM3U\n");
		await expect(assertMediaFileContent(playlist)).rejects.toBeInstanceOf(
			MediaInputPolicyError,
		);
		await expect(
			assertMediaFileContent(join(dir, "sample.mp4")),
		).resolves.toBeUndefined();
	});

	test("streaming playlists from untrusted hosts are refused before any request", async () => {
		requested.length = 0;
		await expect(
			materializeStreamingInput(`http://127.0.0.1:${server.port}/x.m3u8`, dir),
		).rejects.toBeInstanceOf(MediaInputPolicyError);
		expect(requested).toEqual([]);
	});
});
