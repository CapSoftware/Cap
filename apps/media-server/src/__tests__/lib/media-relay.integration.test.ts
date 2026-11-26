import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRelayedInputCount } from "../../lib/media-relay";
import { relayRemoteInputs, spawn } from "../../lib/media-spawn";
import { generateThumbnail } from "../../lib/media-video";

const FIXTURE = readFileSync(
	join(import.meta.dir, "..", "fixtures", "test-with-audio.mp4"),
);

const servers: { stop(force?: boolean): Promise<void> }[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function serve(handler: (request: Request) => Response) {
	const hits: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			hits.push(new URL(request.url).pathname);
			return handler(request);
		},
	});
	servers.push(server);
	return { hits, url: `http://127.0.0.1:${server.port}` };
}

function serveFixture(request: Request): Response {
	const match = request.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
	if (!match) return new Response(FIXTURE);
	const start = Number(match[1]);
	const end = match[2]
		? Math.min(Number(match[2]), FIXTURE.length - 1)
		: FIXTURE.length - 1;
	return new Response(FIXTURE.subarray(start, end + 1), {
		status: 206,
		headers: {
			"Accept-Ranges": "bytes",
			"Content-Range": `bytes ${start}-${end}/${FIXTURE.length}`,
		},
	});
}

async function ffprobeDuration(url: string) {
	const proc = spawn({
		cmd: [
			"ffprobe",
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"csv=p=0",
			url,
		],
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, duration: Number(stdout.trim()), stderr };
}

describe("relayRemoteInputs", () => {
	test("points remote inputs at the relay and leaves everything else alone", () => {
		const local = ["ffmpeg", "-i", "/tmp/a.mp4", "-y", "/tmp/out.mp4"];
		expect(relayRemoteInputs(local).cmd).toEqual(local);
		const other = ["curl", "-i", "https://media.example/a.mp4"];
		expect(relayRemoteInputs(other).cmd).toEqual(other);
		const playlist = ["ffmpeg", "-i", "https://media.example/a.m3u8", "o.mkv"];
		expect(relayRemoteInputs(playlist).cmd).toEqual(playlist);

		const before = getRelayedInputCount();
		const relayed = relayRemoteInputs([
			"ffmpeg",
			"-ss",
			"1",
			"-i",
			"https://media.example/path/My%20clip.mp4?sig=secret",
			"-i",
			"/tmp/b.mp4",
			"-metadata",
			"comment=https://media.example/not-an-input.mp4",
			"out.mp4",
		]);
		expect(relayed.cmd[4]).toMatch(
			/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}\/My_20clip\.mp4$/,
		);
		expect(relayed.cmd.join(" ")).not.toContain("sig=secret");
		expect(relayed.cmd.slice(5)).toEqual([
			"-i",
			"/tmp/b.mp4",
			"-metadata",
			"comment=https://media.example/not-an-input.mp4",
			"out.mp4",
		]);
		expect(getRelayedInputCount()).toBe(before + 1);
		relayed.release();
		expect(getRelayedInputCount()).toBe(before);

		const probe = relayRemoteInputs([
			"ffprobe",
			"-v",
			"error",
			"https://media.example/a.mp4",
		]);
		expect(probe.cmd[3]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/.+\/a\.mp4$/);
		probe.release();
	});

	test("the relay answers only for an input that is still in use", async () => {
		const origin = serve(serveFixture);
		const relayed = relayRemoteInputs(["ffprobe", `${origin.url}/video.mp4`]);
		const url = relayed.cmd[1] as string;
		const live = await fetch(url, { headers: { Range: "bytes=0-9" } });
		expect(live.status).toBe(206);
		expect((await live.arrayBuffer()).byteLength).toBe(10);
		const guessed = await fetch(
			url.replace(/[0-9a-f-]{36}/, crypto.randomUUID()),
		);
		expect(guessed.status).toBe(404);
		relayed.release();
		expect((await fetch(url)).status).toBe(404);
	});
});

describe("remote inputs of FFmpeg and ffprobe", () => {
	test("are read through the relay, with seeking", async () => {
		const origin = serve(serveFixture);
		const before = getRelayedInputCount();
		const probed = await ffprobeDuration(`${origin.url}/video.mp4`);
		expect(probed.stderr).toBe("");
		expect(probed.code).toBe(0);
		expect(probed.duration).toBeGreaterThan(0);

		const thumbnail = await generateThumbnail(
			`${origin.url}/video.mp4`,
			probed.duration,
		);
		expect(thumbnail[0]).toBe(0xff);
		expect(thumbnail[1]).toBe(0xd8);
		expect(origin.hits.length).toBeGreaterThan(1);
		expect(getRelayedInputCount()).toBe(before);
	});

	test("are not followed through a redirect to a private address", async () => {
		const internal = serve(serveFixture);
		const origin = serve(
			() =>
				new Response(null, {
					status: 302,
					headers: { Location: `${internal.url}/video.mp4` },
				}),
		);
		const probed = await ffprobeDuration(`${origin.url}/video.mp4`);
		expect(probed.code).not.toBe(0);
		expect(origin.hits.length).toBeGreaterThan(0);
		expect(internal.hits).toEqual([]);
	});

	test("follow a redirect that stays on the origin", async () => {
		const origin = serve((request) =>
			new URL(request.url).pathname === "/moved.mp4"
				? new Response(null, {
						status: 302,
						headers: { Location: "/video.mp4" },
					})
				: serveFixture(request),
		);
		const probed = await ffprobeDuration(`${origin.url}/moved.mp4`);
		expect(probed.code).toBe(0);
		expect(probed.duration).toBeGreaterThan(0);
	});
});
