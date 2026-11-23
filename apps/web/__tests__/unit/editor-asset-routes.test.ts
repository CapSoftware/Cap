import { gunzipSync } from "node:zlib";
import type { HttpApi } from "@effect/platform";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const videoId = "123e4567-e89b-42d3-a456-426614174000";
const clipPath = "content/videos/00000000-0000-4000-8000-000000000001.webm";
const clipKey = `owner/${videoId}/editor-assets/videos/00000000-0000-4000-8000-000000000001.webm`;
const clipIdentity = JSON.stringify("clip");

const mocks = vi.hoisted(() => ({
	metadata: {} as Record<string, unknown>,
	storedSize: 2048,
	storedIdentity: JSON.stringify("asset") as string | undefined,
	affectedRows: 1,
	writes: [] as unknown[],
	uploadTargets: [] as unknown[],
	disposers: [] as Array<() => Promise<void>>,
}));

vi.mock("@/lib/editor-session", async () => {
	const { Effect } = await import("effect");
	return {
		loadEligibleEditorVideo: (id: string) =>
			Effect.sync(() => ({
				id,
				ownerId: "owner",
				name: "Recording",
				duration: 10,
				source: { type: "webMP4" },
				captionsEnabled: true,
				metadata: mocks.metadata,
			})),
	};
});

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));

vi.mock("@cap/web-backend", async () => {
	const { Context, Effect } = await import("effect");
	const bucket = {
		headObject: () =>
			Effect.sync(() => ({
				ContentLength: mocks.storedSize,
				ETag: mocks.storedIdentity,
			})),
	};
	return {
		Database: Context.GenericTag("Database"),
		Storage: {
			getAccessForVideo: () => Effect.succeed([bucket, false] as const),
			createUploadTargetForVideo: (
				_video: unknown,
				key: string,
				input: unknown,
			) =>
				Effect.sync(() => {
					mocks.uploadTargets.push({ key, input });
					return {
						type: "put",
						url: `https://media.example.com/${key}`,
						headers: { "Content-Type": "image/png" },
					};
				}),
		},
	};
});

vi.mock("@/lib/server", async () => {
	const { HttpAuthMiddleware, Organisation, User } = await import(
		"@cap/web-domain"
	);
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Context, Effect, Layer, Option } = await import("effect");
	const auth = Layer.succeed(
		HttpAuthMiddleware,
		Effect.succeed({
			id: User.UserId.make("owner"),
			email: "owner@example.com",
			activeOrganizationId: Organisation.OrganisationId.make("org"),
			iconUrlOrKey: Option.none(),
		}),
	);
	const database = Layer.succeed(Context.GenericTag("Database"), {
		use: (
			callback: (client: unknown) => Promise<unknown>,
		): import("effect").Effect.Effect<unknown> =>
			Effect.promise(() =>
				callback({
					update: () => ({
						set: (value: unknown) => ({
							where: async () => {
								mocks.writes.push(value);
								return [{ affectedRows: mocks.affectedRows }];
							},
						}),
					}),
				}),
			),
	});
	return {
		apiToHandler: (
			api: import("effect").Layer.Layer<
				HttpApi.Api,
				never,
				import("@cap/web-domain").HttpAuthMiddleware
			>,
		) => {
			const handler = api.pipe(
				Layer.provideMerge(auth),
				Layer.provide(database),
				Layer.merge(HttpServer.layerContext),
				HttpApiBuilder.toWebHandler,
			);
			mocks.disposers.push(handler.dispose);
			return handler.handler;
		},
	};
});

import * as assets from "@/app/api/editor/videos/[videoId]/assets/route";
import * as clips from "@/app/api/editor/videos/[videoId]/clips/route";

function json(
	handler: (request: Request) => Promise<Response>,
	route: string,
	method: string,
	body: unknown,
) {
	return handler(
		new Request(`https://cap.so/api/editor/videos/${videoId}/${route}`, {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

afterAll(async () => {
	await Promise.all(mocks.disposers.map((dispose) => dispose()));
});

function sqlStrings(value: unknown): string[] {
	const chunks =
		typeof value === "object" && value !== null && "metadata" in value
			? (value.metadata as { queryChunks?: unknown[] }).queryChunks
			: undefined;
	return (chunks ?? []).filter(
		(chunk): chunk is string => typeof chunk === "string",
	);
}

const image = {
	kind: "image",
	fileName: "Wallpaper.jpeg",
	size: 2048,
	contentType: "image/jpeg",
};

describe("web editor asset uploads", () => {
	beforeEach(() => {
		mocks.metadata = {};
		mocks.storedSize = 2048;
		mocks.storedIdentity = JSON.stringify("asset");
		mocks.affectedRows = 1;
		mocks.writes.length = 0;
		mocks.uploadTargets.length = 0;
	});

	it("prepares an upload into the recording's editor assets", async () => {
		const response = await json(assets.POST, "assets", "POST", image);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.path).toMatch(/^content\/images\/[0-9a-f-]{36}\.jpg$/);
		expect(body.key).toBe(
			`owner/${videoId}/editor-assets/images/${body.path.slice("content/images/".length)}`,
		);
		expect(body.upload.type).toBe("put");
		expect(mocks.uploadTargets).toEqual([
			{
				key: body.key,
				input: expect.objectContaining({
					contentType: "image/jpeg",
					contentLength: 2048,
					method: "put",
				}),
			},
		]);
	});

	it("refuses files whose type doesn't match their name", async () => {
		const response = await json(assets.POST, "assets", "POST", {
			...image,
			contentType: "image/png",
		});
		expect(response.status).toBe(400);
		expect(mocks.uploadTargets).toEqual([]);
	});

	it("records an uploaded image with the size the browser measured", async () => {
		const path = "content/images/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg";
		const response = await json(assets.PUT, "assets", "PUT", {
			...image,
			path,
			key: `owner/${videoId}/editor-assets/images/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg`,
			width: 1920,
			height: 1080,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			path,
			name: "Wallpaper",
			width: 1920,
			height: 1080,
		});
		expect(mocks.writes).toHaveLength(1);
	});

	it("refuses missing or implausible measurements and changed uploads", async () => {
		const path = "content/images/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg";
		const complete = (extra: Record<string, unknown>) =>
			json(assets.PUT, "assets", "PUT", {
				...image,
				path,
				key: `owner/${videoId}/editor-assets/images/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg`,
				...extra,
			});
		expect((await complete({})).status).toBe(400);
		expect((await complete({ width: 8000, height: 8000 })).status).toBe(400);
		mocks.storedSize = 1024;
		expect((await complete({ width: 10, height: 10 })).status).toBe(503);
		expect(mocks.writes).toEqual([]);
	});

	it("records audio with its measured duration and refuses a lost race", async () => {
		const audio = {
			kind: "audio",
			fileName: "Music.mp3",
			size: 2048,
			contentType: "audio/mpeg",
			path: "assets/audio/import-cccccccc-cccc-4ccc-8ccc-cccccccccccc.mp3",
			key: `owner/${videoId}/editor-assets/import-cccccccc-cccc-4ccc-8ccc-cccccccccccc.mp3`,
		};
		const response = await json(assets.PUT, "assets", "PUT", {
			...audio,
			duration: 12.5,
		});
		expect(await response.json()).toEqual({
			path: audio.path,
			name: "Music",
			duration: 12.5,
		});
		mocks.affectedRows = 0;
		expect(
			(await json(assets.PUT, "assets", "PUT", { ...audio, duration: 12.5 }))
				.status,
		).toBe(409);
		expect(
			(await json(assets.PUT, "assets", "PUT", { ...audio, duration: -1 }))
				.status,
		).toBe(400);
	});
});

describe("web editor clip registration", () => {
	beforeEach(() => {
		mocks.metadata = {
			webEditorVideos: {
				version: 1,
				items: [
					{
						key: clipKey,
						path: clipPath,
						name: "Clip",
						contentType: "video/webm",
						size: 3000,
						objectIdentity: clipIdentity,
					},
				],
			},
		};
		mocks.storedSize = 3000;
		mocks.storedIdentity = clipIdentity;
		mocks.affectedRows = 1;
		mocks.writes.length = 0;
	});

	const clip = { path: clipPath, duration: 5, fps: 30, hasAudio: true };

	it("needs the editor's project when the recording was never saved", async () => {
		expect((await json(clips.POST, "clips", "POST", clip)).status).toBe(409);
		expect(mocks.writes).toEqual([]);
	});

	it("appends the clip to the timeline after the recording", async () => {
		const response = await json(clips.POST, "clips", "POST", {
			...clip,
			projectConfig: { background: { source: { type: "color" } } },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ count: 1 });
		expect(mocks.writes).toHaveLength(1);
		const written = sqlStrings(mocks.writes[0]);
		const project = written.find((value) => value.includes("savedAt"));
		const savedClip = written.find((value) => value.includes("displayPath"));
		const order = written.find((value) => value.includes('"items"'));
		expect(JSON.parse(savedClip ?? "null")).toEqual({
			displayPath: clipPath,
			duration: 5,
			fps: 30,
			hasAudio: true,
		});
		expect(JSON.parse(order ?? "null")).toEqual({
			version: 1,
			items: [{ kind: "clip", path: clipPath }],
		});
		expect(JSON.parse(project ?? "null")).toMatchObject({ version: 2 });
	});

	it("places the clip after the recording's own length, not a shorter Save's", async () => {
		mocks.metadata = { ...mocks.metadata, editorSourceDuration: 60 };
		const response = await json(clips.POST, "clips", "POST", {
			...clip,
			projectConfig: { background: { source: { type: "color" } } },
		});
		expect(response.status).toBe(200);
		const project = sqlStrings(mocks.writes[0]).find((value) =>
			value.includes("savedAt"),
		);
		const saved = JSON.parse(project ?? "null");
		const config = JSON.parse(
			gunzipSync(Buffer.from(saved.configGzipBase64, "base64")).toString(),
		);
		expect(config.timeline.segments).toEqual([
			{ recordingSegment: 0, timescale: 1, start: 0, end: 60 },
			{ recordingSegment: 1, timescale: 1, start: 0, end: 5 },
		]);
	});

	it("refuses clips the browser measured outside what a clip stores", async () => {
		const response = await json(clips.POST, "clips", "POST", {
			...clip,
			fps: 0,
			projectConfig: {},
		});
		expect(response.status).toBe(400);
		expect(mocks.writes).toEqual([]);
	});

	it("refuses a camera that wasn't uploaded", async () => {
		const response = await json(clips.POST, "clips", "POST", {
			...clip,
			camera: {
				path: "content/videos/00000000-0000-4000-8000-000000000002.webm",
				fps: 30,
				offsetMs: 0,
			},
			projectConfig: {},
		});
		expect(response.status).toBe(400);
	});

	it("refuses an upload replaced after it completed", async () => {
		mocks.storedIdentity = JSON.stringify("replacement");
		const response = await json(clips.POST, "clips", "POST", {
			...clip,
			projectConfig: {},
		});
		expect(response.status).toBe(503);
		expect(mocks.writes).toEqual([]);
	});
});
