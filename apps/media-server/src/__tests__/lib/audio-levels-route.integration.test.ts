import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import audioLevels from "../../routes/audio-levels";

let directory: string;
let source: Uint8Array;
const originalFetch = globalThis.fetch;
const originalSecret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
const request = {
	sourceUrl: "https://storage.test/source.mp4",
	sourceIdentity: '"source"',
	sourceSize: 1,
	outputUrl: "https://storage.test/output.mp4",
	verificationUrl: "https://storage.test/output.mp4",
};

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "cap-audio-route-"));
	const path = join(directory, "source.mp4");
	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=160x90:rate=15:duration=4",
			"-f",
			"lavfi",
			"-i",
			"aevalsrc=0.02*sin(2*PI*440*t):s=48000:d=4",
			"-c:v",
			"libx264",
			"-preset",
			"ultrafast",
			"-c:a",
			"aac",
			"-threads",
			"1",
			path,
		],
		{ stdout: "ignore", stderr: "pipe" },
	);
	const [code, error] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
	]);
	if (code !== 0) throw new Error(error);
	source = await readFile(path);
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalSecret === undefined)
		delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	else process.env.MEDIA_SERVER_WEBHOOK_SECRET = originalSecret;
});
afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

function call(
	body = { ...request, sourceSize: source.byteLength },
	authorized = true,
) {
	process.env.MEDIA_SERVER_WEBHOOK_SECRET = "test-secret";
	return audioLevels.request("https://media.test/levels", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(authorized ? { "x-media-server-secret": "test-secret" } : {}),
		},
		body: JSON.stringify(body),
	});
}

function storage(
	options: {
		changedSource?: boolean;
		corruptUpload?: boolean;
		download?: () => Promise<void>;
	} = {},
) {
	let output: ArrayBuffer | undefined;
	let uploads = 0;
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url === request.sourceUrl) {
				await options.download?.();
				expect(new Headers(init?.headers).get("If-Match")).toBe(
					request.sourceIdentity,
				);
				return new Response(Buffer.from(source), {
					headers: { ETag: options.changedSource ? '"changed"' : '"source"' },
				});
			}
			expect(url).toBe(request.outputUrl);
			if (init?.method === "PUT") {
				expect(new Headers(init.headers).get("If-None-Match")).toBe("*");
				output = await new Response(init.body).arrayBuffer();
				uploads++;
				return new Response(null, { headers: { ETag: '"output"' } });
			}
			if (!output) throw new Error("Output not uploaded");
			const bytes = output.slice(0);
			if (options.corruptUpload) new Uint8Array(bytes)[0] ^= 1;
			return new Response(init?.method === "HEAD" ? null : bytes, {
				headers: {
					ETag: '"output"',
					"Content-Length": String(bytes.byteLength),
					"Content-Type": "video/mp4",
				},
			});
		},
		{ preconnect: originalFetch.preconnect },
	);
	return { uploads: () => uploads };
}

describe("audio levels serving boundary", () => {
	test("publishes only after packet, audio and remote-byte verification", async () => {
		const objects = storage();
		const response = await call();
		const result = await response.json();
		expect(result.status).toBe("verified");
		expect(result.outputLufs).toBeGreaterThan(result.inputLufs + 1);
		expect(result.truePeak).toBeLessThanOrEqual(-1);
		expect(objects.uploads()).toBe(1);
	});
	test("retains the original when stored output bytes differ", async () => {
		storage({ corruptUpload: true });
		expect((await (await call()).json()).status).toBe("unchanged");
	});
	test("does not process a changed source identity", async () => {
		const objects = storage({ changedSource: true });
		expect((await (await call()).json()).status).toBe("unchanged");
		expect(objects.uploads()).toBe(0);
	});
	test("rejects oversized source and unauthorized requests", async () => {
		expect(
			(await call({ ...request, sourceSize: 257 * 1024 * 1024 })).status,
		).toBe(400);
		expect((await call(undefined, false)).status).toBe(401);
	});
	test("limits enhancement concurrency without rejecting the recording", async () => {
		let release: () => void = () => {};
		let entered: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		storage({
			download: async () => {
				entered();
				await pending;
			},
		});
		const first = call();
		await started;
		try {
			expect(await (await call()).json()).toEqual({
				status: "unchanged",
				reason: "capacity",
			});
		} finally {
			release();
		}
		expect((await (await first).json()).status).toBe("verified");
	});
});
