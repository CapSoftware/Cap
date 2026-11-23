import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectCache } from "./materialize";
import {
	builtinPath,
	type PrepareDeps,
	parsePrepareRequest,
	prepareRecording,
} from "./prepare";
import type { S3 } from "./s3";
import { validateJobRequest } from "./validate";

const prefix = "owner/video/.recording/render/x/project";
const encode = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value));
const request = {
	version: 1,
	sources: { title: "Take" },
	display: { key: "owner/video/raw-upload.mp4", contentType: "video/mp4" },
	inputEvents: { key: "owner/video/input-events-upload.ndjson", size: 6 },
	sessionDefaults: true,
};

function harness(manifest: unknown, prepare: unknown = request) {
	const objects = new Map<string, Uint8Array | string>([
		[`${prefix}/manifest.json`, encode(manifest)],
		[`${prefix}/prepare.json`, encode(prepare)],
		[
			"owner/video/input-events-upload.ndjson",
			new TextEncoder().encode("{}\n{}\n"),
		],
	]);
	const engineCalls: { op: string; body: Record<string, unknown> }[] = [];
	const deps: PrepareDeps = {
		async getBounded(key, limit) {
			const value = objects.get(key);
			if (value === undefined) throw new Error(`missing ${key}`);
			const bytes =
				typeof value === "string" ? new TextEncoder().encode(value) : value;
			if (bytes.byteLength > limit) throw new Error("too large");
			return bytes;
		},
		async put(key, body) {
			objects.set(key, typeof body === "string" ? body : new Uint8Array(body));
		},
		presignGet: async (key) => `https://s3.test/${key}?signed`,
		inScope: (key) => key.startsWith("owner/video/"),
		async engine<T>(op: string, body: Record<string, unknown>) {
			engineCalls.push({ op, body });
			const project = body.project as string;
			mkdirSync(join(project, "content/segments/segment-0"), {
				recursive: true,
			});
			writeFileSync(join(project, "recording-meta.json"), '{"meta":1}');
			writeFileSync(join(project, "project-config.json"), '{"config":1}');
			writeFileSync(
				join(project, "content/segments/segment-0/cursor.json"),
				"[]",
			);
			return {
				files: [
					{ path: "content/segments/segment-0/cursor.json", size: 2 },
					{ path: "project-config.json", size: 12 },
					{ path: "recording-meta.json", size: 10 },
				],
			} as T;
		},
	};
	return { objects, engineCalls, deps };
}

describe("prepareRecording", () => {
	test("writes the project files next to the media and lists them in the manifest", async () => {
		const media = {
			path: "content/segments/segment-0/display.h264.mp4",
			key: "k",
			transcodeFrom: "owner/video/raw-upload.mp4",
		};
		const { objects, engineCalls, deps } = harness({ files: [media] });
		const work = mkdtempSync(join(tmpdir(), "rf-prepare-"));
		expect(await prepareRecording(prefix, "prepare.json", work, deps)).toBe(
			true,
		);

		expect(engineCalls).toHaveLength(1);
		expect(engineCalls[0]?.op).toBe("prepare");
		expect(engineCalls[0]?.body).toMatchObject({
			sources: { title: "Take" },
			display_source: "https://s3.test/owner/video/raw-upload.mp4?signed",
			display_content_type: "video/mp4",
			session_defaults: true,
		});
		expect(
			readFileSync(engineCalls[0]?.body.input_events as string, "utf8"),
		).toBe("{}\n{}\n");
		expect(
			new TextDecoder().decode(
				objects.get(`${prefix}/recording-meta.json`) as Uint8Array,
			),
		).toBe('{"meta":1}');
		expect(
			JSON.parse(objects.get(`${prefix}/manifest.json`) as string),
		).toEqual({
			files: [
				media,
				{ path: "content/segments/segment-0/cursor.json", size: 2 },
				{ path: "project-config.json", size: 12 },
				{ path: "recording-meta.json", size: 10 },
			],
		});
	});

	test("leaves a manifest that already lists the project files alone", async () => {
		const { engineCalls, deps } = harness({
			files: [{ path: "recording-meta.json", size: 1 }],
		});
		expect(
			await prepareRecording(
				prefix,
				"prepare.json",
				mkdtempSync(join(tmpdir(), "rf-")),
				deps,
			),
		).toBe(false);
		expect(engineCalls).toHaveLength(0);
	});

	test("refuses sources outside the recording and input events that changed", async () => {
		const outside = harness(
			{ files: [] },
			{
				...request,
				display: { key: "other/video/raw.mp4", contentType: "video/mp4" },
			},
		);
		await expect(
			prepareRecording(
				prefix,
				"prepare.json",
				mkdtempSync(join(tmpdir(), "rf-")),
				outside.deps,
			),
		).rejects.toThrow("outside the recording");
		const resized = harness(
			{ files: [] },
			{ ...request, inputEvents: { ...request.inputEvents, size: 99 } },
		);
		await expect(
			prepareRecording(
				prefix,
				"prepare.json",
				mkdtempSync(join(tmpdir(), "rf-")),
				resized.deps,
			),
		).rejects.toThrow("changed size");
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
		const s3 = {
			getRange: () => {
				throw new Error("fetched");
			},
		} as unknown as S3;
		const cache = new ProjectCache(s3, join(dir, "project"));
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
