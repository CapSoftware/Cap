import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../../app";
import { readPreverifiedRun } from "../../lib/recording-preverify";

const SECRET = "test-secret";
process.env.MEDIA_SERVER_WEBHOOK_SECRET = SECRET;

type Served = {
	body: Uint8Array<ArrayBuffer>;
	etag: string;
	status?: number;
	hang?: boolean;
	delayMs?: number;
};
const objects = new Map<string, Served>();
const uploads = new Map<string, string>();
let openHangs = 0;
let server: ReturnType<typeof Bun.serve>;
let base: string;

async function run(command: string[]) {
	const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
	if ((await child.exited) !== 0)
		throw new Error(await new Response(child.stderr).text());
}

beforeAll(async () => {
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const key = new URL(request.url).pathname;
			if (request.method === "PUT") {
				uploads.set(key, await request.text());
				return new Response(null, { status: 200, headers: { ETag: '"put"' } });
			}
			const served = objects.get(key);
			if (!served) return new Response(null, { status: 404 });
			if (served.hang) {
				openHangs++;
				await new Promise<void>((resolve) =>
					request.signal.addEventListener("abort", () => resolve(), {
						once: true,
					}),
				);
				openHangs--;
				return new Response(null, { status: 499 });
			}
			if (served.delayMs) await Bun.sleep(served.delayMs);
			if (served.status) return new Response(null, { status: served.status });
			return new Response(served.body, {
				headers: {
					ETag: served.etag,
					"Content-Length": String(served.body.length),
				},
			});
		},
	});
	base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

function source(key: string) {
	const served = objects.get(key);
	if (!served) throw new Error(`Missing ${key}`);
	return {
		url: `${base}${key}`,
		objectIdentity: served.etag,
		size: served.body.length || 1,
	};
}

function request(body: unknown, secret = SECRET) {
	return app.fetch(
		new Request("http://localhost/video/preverify-segments", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-media-server-secret": secret,
			},
			body: JSON.stringify(body),
		}),
	);
}

async function until(check: () => boolean, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting");
		await Bun.sleep(50);
	}
}

async function seedFragments(name: string) {
	const directory = await mkdtemp(join(tmpdir(), `preverify-${name}-`));
	await run([
		"ffmpeg",
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=320x180:rate=30",
		"-frames:v",
		"60",
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-g",
		"15",
		"-keyint_min",
		"15",
		"-sc_threshold",
		"0",
		"-pix_fmt",
		"yuv420p",
		"-f",
		"dash",
		"-seg_duration",
		"0.5",
		"-init_seg_name",
		"init.mp4",
		"-media_seg_name",
		"fragment-$Number%05d$.m4s",
		join(directory, "manifest.mpd"),
	]);
	const files = (await readdir(directory))
		.filter((file) => /^fragment-\d+\.m4s$/.test(file))
		.sort();
	const keys: string[] = [];
	for (const [index, file] of ["init.mp4", ...files].entries()) {
		const key = `/${name}/${file}`;
		objects.set(key, {
			body: new Uint8Array(await readFile(join(directory, file))),
			etag: `"${name}-${index}"`,
		});
		keys.push(key);
	}
	return keys;
}

describe("POST /video/preverify-segments", () => {
	test("requires the media server secret and a complete body", async () => {
		expect((await request({}, "wrong")).status).toBe(401);
		expect((await request({ videoId: "video" })).status).toBe(400);
	});

	test("stores a signed run that names the exact fragments it decoded", async () => {
		const [init, ...fragments] = await seedFragments("signed");
		if (!init) throw new Error("Missing init");
		const response = await request({
			videoId: "video",
			init: source(init),
			segments: fragments.map(source),
			resultUploadUrl: `${base}/results/signed.json`,
		});
		expect(response.status).toBe(202);
		await until(() => uploads.has("/results/signed.json"));
		const run = readPreverifiedRun(
			uploads.get("/results/signed.json") ?? "",
			SECRET,
		);
		expect(run?.init).toEqual({
			objectIdentity: source(init).objectIdentity,
			size: source(init).size,
		});
		expect(run?.segments.map((segment) => segment.objectIdentity)).toEqual(
			fragments.map((key) => source(key).objectIdentity),
		);
		expect(run?.lines.filter((line) => !line.startsWith("#"))).toHaveLength(60);
	});

	test("stops every download and frees its slot when one fragment fails", async () => {
		const [init, first, ...rest] = await seedFragments("failing");
		if (!init || !first) throw new Error("Missing fragments");
		objects.set(first, {
			...(objects.get(first) as Served),
			status: 403,
			delayMs: 300,
		});
		for (const key of rest)
			objects.set(key, { ...(objects.get(key) as Served), hang: true });
		const response = await request({
			videoId: "video",
			init: source(init),
			segments: [first, ...rest].map(source),
			resultUploadUrl: `${base}/results/failing.json`,
		});
		expect(response.status).toBe(202);
		await until(() => openHangs > 0);
		await until(() => openHangs === 0);
		const [, ...healthy] = await seedFragments("after-failure");
		const accepted = await Promise.all(
			[0, 1].map(
				async () =>
					(
						await request({
							videoId: "video",
							init: source(`/after-failure/init.mp4`),
							segments: healthy.slice(0, 2).map(source),
							resultUploadUrl: `${base}/results/after-${Math.random()}.json`,
						})
					).status,
			),
		);
		expect(accepted).toEqual([202, 202]);
		expect(uploads.has("/results/failing.json")).toBe(false);
		await until(
			() =>
				[...uploads.keys()].filter((key) => key.startsWith("/results/after-"))
					.length === 2,
		);
	});

	test("declines a third concurrent run", async () => {
		const [init, ...fragments] = await seedFragments("busy");
		if (!init) throw new Error("Missing init");
		for (const key of fragments)
			objects.set(key, { ...(objects.get(key) as Served), hang: true });
		const body = (name: string) => ({
			videoId: "video",
			init: source(init),
			segments: fragments.slice(0, 1).map(source),
			resultUploadUrl: `${base}/results/${name}.json`,
		});
		expect((await request(body("busy-1"))).status).toBe(202);
		expect((await request(body("busy-2"))).status).toBe(202);
		expect((await request(body("busy-3"))).status).toBe(503);
	});
});
