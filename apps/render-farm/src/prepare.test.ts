import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine";
import { localS3, memoryBucket, stopLocalS3 } from "./local-s3.test-util";
import { ProjectCache } from "./materialize";
import {
	builtinPath,
	type PrepareStorage,
	parsePrepareRequest,
	prepareRecording,
	stagePrepare,
} from "./prepare";
import type { S3 } from "./s3";
import { validateJobRequest } from "./validate";

afterEach(stopLocalS3);

const prefix = "owner/video/.recording/render/x/project";
const displayKey = "owner/video/raw-upload.mp4";
const inputEventsKey = "owner/video/input-events-upload.ndjson";
const display = readFileSync(
	new URL("./fixtures/recorder-indexed.mp4", import.meta.url),
);
const inputEvents = new TextEncoder().encode(
	`${JSON.stringify({ version: 1, platform: "MacOS" })}\n${JSON.stringify({
		kind: "move",
		timeMs: 100,
		x: 0.1,
		y: 0.2,
		cursor: "default",
		button: 0,
		modifiers: [],
	})}\n`,
);
const sources = {
	title: "Take",
	display: { path: "content/segments/segment-0/display.h264.mp4", fps: 30 },
	camera: null,
	mic: { path: "content/segments/segment-0/mic.mic.opus", offsetMs: 2 },
	systemAudio: null,
	audioDefault: null,
	initialProjectConfig: null,
	legacyEditSpec: null,
};
const request = {
	version: 1,
	sources,
	display: { key: displayKey, contentType: "video/mp4" },
	inputEvents: { key: inputEventsKey, size: inputEvents.byteLength },
	sessionDefaults: true,
};
const media = {
	path: "content/segments/segment-0/display.h264.mp4",
	key: "k",
	transcodeFrom: displayKey,
};

function storage(s3: S3): PrepareStorage {
	return {
		async getBounded(key, limit) {
			const bytes = await s3.getRange(key, 0, limit);
			if (bytes.byteLength > limit) {
				throw new Error(`${key} is larger than ${limit} bytes`);
			}
			return bytes;
		},
		put: (key, body, contentType) => s3.put(key, body, contentType),
		presignGet: (key) => s3.presignFresh("GET", key, 6 * 3600),
		inScope: (key) => key.startsWith("owner/video/"),
	};
}

async function recording(
	prepare: unknown = request,
	manifest: unknown = { files: [media] },
) {
	const bucket = memoryBucket();
	const s3 = localS3(bucket.handle);
	await s3.put(
		`${prefix}/manifest.json`,
		JSON.stringify(manifest),
		"application/json",
	);
	await s3.put(
		`${prefix}/prepare.json`,
		JSON.stringify(prepare),
		"application/json",
	);
	await s3.put(inputEventsKey, inputEvents);
	await s3.put(displayKey, display);
	bucket.requests.length = 0;
	return { bucket, s3, work: mkdtempSync(join(tmpdir(), "rf-prepare-")) };
}

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe("stagePrepare", () => {
	test("downloads the input events and presigns the display for the engine", async () => {
		const { bucket, s3, work } = await recording();
		let seen: unknown;
		const staged = await stagePrepare(prefix, "prepare.json", work, {
			...storage(s3),
			onManifest: (manifest) => {
				seen = manifest;
			},
		});
		expect(seen).toEqual({ files: [media] });
		expect(staged?.manifest).toEqual({ files: [media] });
		expect(staged?.project).toBe(join(work, "prepared"));
		expect(staged?.engineRequest).toMatchObject({
			project: join(work, "prepared"),
			sources,
			input_events: join(work, "input-events.ndjson"),
			display_content_type: "video/mp4",
			session_defaults: true,
		});
		expect(readFileSync(staged?.engineRequest.input_events as string)).toEqual(
			Buffer.from(inputEvents),
		);

		const signed = new URL(staged?.engineRequest.display_source as string);
		expect(signed.pathname).toBe(`/bucket/${displayKey}`);
		expect(signed.searchParams.get("X-Amz-Signature")).toMatch(
			/^[0-9a-f]{64}$/,
		);
		const served = await fetch(signed);
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(
			new Uint8Array(display),
		);
		expect(bucket.requests).toEqual([
			`GET ${prefix}/manifest.json`,
			`GET ${prefix}/prepare.json`,
			`GET ${inputEventsKey}`,
			`GET ${displayKey}`,
		]);
	});

	test("leaves a manifest that already lists the project files alone", async () => {
		const { bucket, s3, work } = await recording(request, {
			files: [{ path: "recording-meta.json", size: 1 }],
		});
		expect(
			await stagePrepare(prefix, "prepare.json", work, storage(s3)),
		).toBeNull();
		expect(bucket.requests).toEqual([`GET ${prefix}/manifest.json`]);
	});

	test("without input events the engine gets none", async () => {
		const { s3, work } = await recording({
			...request,
			inputEvents: null,
			sessionDefaults: false,
		});
		const staged = await stagePrepare(
			prefix,
			"prepare.json",
			work,
			storage(s3),
		);
		expect(staged?.engineRequest.input_events).toBeUndefined();
		expect(staged?.engineRequest.session_defaults).toBe(false);
	});

	test("refuses sources outside the recording", async () => {
		for (const prepare of [
			{
				...request,
				display: { key: "other/video/raw.mp4", contentType: "video/mp4" },
			},
			{
				...request,
				inputEvents: { key: "other/video/events.ndjson", size: 6 },
			},
		]) {
			const { bucket, s3, work } = await recording(prepare);
			await expect(
				stagePrepare(prefix, "prepare.json", work, storage(s3)),
			).rejects.toThrow("outside the recording");
			expect(bucket.requests).toEqual([
				`GET ${prefix}/manifest.json`,
				`GET ${prefix}/prepare.json`,
			]);
		}
	});

	test("refuses input events that changed size", async () => {
		const { s3, work } = await recording({
			...request,
			inputEvents: { key: inputEventsKey, size: inputEvents.byteLength + 1 },
		});
		await expect(
			stagePrepare(prefix, "prepare.json", work, storage(s3)),
		).rejects.toThrow("changed size");
	});

	test("reads at most 8 MiB of prepare.json", async () => {
		const { s3, work } = await recording({
			...request,
			sources: { ...sources, title: "x".repeat(8 << 20) },
		});
		await expect(
			stagePrepare(prefix, "prepare.json", work, storage(s3)),
		).rejects.toThrow(`larger than ${8 << 20} bytes`);
	});
});

const engineBinary = process.env.RF_ENGINE_BIN;

describe.skipIf(!engineBinary)("prepareRecording with the farm engine", () => {
	let engine: Engine;
	beforeAll(() => {
		engine = new Engine(engineBinary ?? "", {}, "prepare-test");
	});
	afterAll(() => engine.kill());

	async function prepare(prepareRequest: unknown) {
		const { bucket, s3, work } = await recording(prepareRequest);
		const prepared = await prepareRecording(prefix, "prepare.json", work, {
			...storage(s3),
			engine: (op, body) => engine.request(op, body),
		});
		const object = (path: string) => bucket.objects.get(`${prefix}/${path}`);
		const manifest = JSON.parse(text(object("manifest.json")?.body)) as {
			files: { path: string; size?: number }[];
		};
		for (const file of manifest.files.slice(1)) {
			const uploaded = object(file.path);
			expect(uploaded?.body).toEqual(
				new Uint8Array(readFileSync(join(work, "prepared", file.path))),
			);
			expect(uploaded?.body.byteLength).toBe(file.size ?? -1);
			expect(uploaded?.contentType).toBe(
				file.path.endsWith(".json")
					? "application/json"
					: "application/octet-stream",
			);
		}
		return { prepared, bucket, s3, manifest, object };
	}

	test("writes a never-edited recording's project next to its media", async () => {
		const { prepared, bucket, s3, manifest, object } = await prepare(request);
		expect(prepared).toBe(true);
		expect(manifest.files[0]).toEqual(media);
		expect(manifest.files.slice(1).map((file) => file.path)).toEqual([
			"content/cursors/web-default.png",
			"content/segments/segment-0/cursor.json",
			"project-config.json",
			"recording-meta.json",
		]);

		const config = JSON.parse(text(object("project-config.json")?.body));
		expect(config.timeline.segments).toHaveLength(1);
		expect(config.timeline.segments[0].start).toBe(0);
		expect(config.timeline.segments[0].end).toBeCloseTo(6.99, 1);
		expect(config.clips).toHaveLength(1);
		const meta = JSON.parse(text(object("recording-meta.json")?.body));
		expect(meta.segments[0].display.path).toBe(media.path);
		expect(meta.segments[0].cursor).toBe(
			"content/segments/segment-0/cursor.json",
		);
		const cursor = JSON.parse(
			text(object("content/segments/segment-0/cursor.json")?.body),
		);
		expect(cursor.moves).toHaveLength(1);
		expect(bucket.requests).toContain(`GET ${displayKey}`);

		const before = object("manifest.json")?.body;
		const work = mkdtempSync(join(tmpdir(), "rf-prepare-"));
		expect(
			await prepareRecording(prefix, "prepare.json", work, {
				...storage(s3),
				engine: (op, body) => engine.request(op, body),
			}),
		).toBe(false);
		expect(object("manifest.json")?.body).toBe(before);
	});

	test("a recording without input events or session defaults keeps its saved project", async () => {
		const { prepared, bucket, manifest, object } = await prepare({
			...request,
			inputEvents: null,
			sessionDefaults: false,
		});
		expect(prepared).toBe(true);
		expect(manifest.files.slice(1).map((file) => file.path)).toEqual([
			"project-config.json",
			"recording-meta.json",
		]);
		const config = JSON.parse(text(object("project-config.json")?.body));
		expect(config.timeline ?? null).toBeNull();
		expect(config.clips ?? []).toEqual([]);
		expect(bucket.requests).not.toContain(`GET ${displayKey}`);
		expect(bucket.requests).not.toContain(`GET ${inputEventsKey}`);
	});
});

describe("parsePrepareRequest", () => {
	test("accepts only a version 1 request with a video display", () => {
		expect(parsePrepareRequest(request).display.contentType).toBe("video/mp4");
		expect(() => parsePrepareRequest({ ...request, version: 2 })).toThrow();
		expect(() =>
			parsePrepareRequest({
				...request,
				display: { key: "k", contentType: "audio/webm" },
			}),
		).toThrow();
		expect(() =>
			parsePrepareRequest({ ...request, inputEvents: { key: "k", size: 0 } }),
		).toThrow();
		expect(() =>
			parsePrepareRequest({
				...request,
				inputEvents: { key: "k", size: (64 << 20) + 1 },
			}),
		).toThrow();
		expect(
			parsePrepareRequest({ ...request, inputEvents: null }).inputEvents,
		).toBeNull();
		expect(
			parsePrepareRequest({ ...request, sessionDefaults: undefined })
				.sessionDefaults,
		).toBe(false);
	});
});

describe("built-in assets", () => {
	test("only wallpapers and library tracks are built in", () => {
		expect(builtinPath("backgrounds/macOS/sequoia-dark.jpg")).toEndWith(
			"/backgrounds/macOS/sequoia-dark.jpg",
		);
		expect(builtinPath("music/calm-1.mp3")).toEndWith("/music/calm-1.mp3");
		expect(builtinPath("backgrounds/../../etc/passwd")).toBeNull();
		expect(builtinPath("music/Calm.mp3")).toBeNull();
		expect(builtinPath("backgrounds/other/x.jpg")).toBeNull();
	});

	test("a built-in file is copied from the machine, not fetched", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rf-builtin-"));
		const local = join(dir, "wallpaper.jpg");
		writeFileSync(local, "jpeg-bytes");
		const bucket = memoryBucket();
		const cache = new ProjectCache(
			localS3(bucket.handle),
			join(dir, "project"),
		);
		await cache.materialize([
			{
				path: "assets/backgrounds/macOS/x.jpg",
				key: "",
				size: 10,
				ranges: "all",
				local,
			},
		]);
		cache.close();
		expect(
			readFileSync(join(dir, "project/assets/backgrounds/macOS/x.jpg"), "utf8"),
		).toBe("jpeg-bytes");
		expect(bucket.requests).toEqual([]);
	});
});

describe("validateJobRequest", () => {
	test("prepare names a JSON file in the recording", () => {
		const base = { recording: prefix, sourceRoot: "owner/video/" };
		expect(
			typeof validateJobRequest({ ...base, prepare: "prepare.json" }),
		).toBe("object");
		expect(validateJobRequest({ ...base, prepare: "../prepare.json" })).toBe(
			"prepare must name a JSON file in the recording",
		);
		expect(validateJobRequest({ ...base, prepare: 1 })).toBe(
			"prepare must name a JSON file in the recording",
		);
	});
});
