import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ keys: new Set<string>() }));

vi.mock("@cap/web-backend/src/S3Buckets/index", async () => {
	const { Effect, Layer, Context, Option } = await import("effect");
	class S3Buckets extends Context.Tag("S3Buckets")<S3Buckets, object>() {
		static Default = Layer.succeed(S3Buckets, {});
		static getBucketAccess = () =>
			Effect.succeed([
				{
					listObjects: ({ prefix }: { prefix: string }) =>
						Effect.succeed({
							Contents: [...store.keys]
								.filter((key) => key.startsWith(prefix))
								.map((Key) => ({ Key })),
						}),
					deleteObjects: (objects: { Key: string }[]) => {
						for (const object of objects) store.keys.delete(object.Key);
						return Effect.succeed(Option.some({}));
					},
				},
			]);
	}
	return { S3Buckets };
});
vi.mock("@cap/database", () => ({ db: () => ({}) }));

const { deleteDeveloperVideoObjects, developerVideoPrefix } = await import(
	"@/lib/developer-video-storage"
);
const { videoCaptionsKey } = await import("@/lib/developer-video-captions");

const VIDEO = { id: "video-1", appId: "app-1" };
const OTHER = { id: "video-2", appId: "app-1" };
const ENCODE = "developer/app-1/video-1/encode-1/";

beforeEach(() => {
	store.keys = new Set([
		"developer/app-1/video-1/video",
		`${ENCODE}out-1/video.mp4`,
		`${ENCODE}out-1/hls/master.m3u8`,
		`${ENCODE}out-0/hls/master.m3u8`,
		videoCaptionsKey(VIDEO, "en"),
		videoCaptionsKey(VIDEO, "de"),
		videoCaptionsKey(OTHER, "en"),
		"developer/app-1/transcripts/tr-1/result.json",
	]);
});

describe("caption files and the video file purge", () => {
	it("keeps caption files inside the folder the purge deletes", () => {
		expect(videoCaptionsKey(VIDEO, "en")).toBe(
			`${developerVideoPrefix(VIDEO)}captions/en.vtt`,
		);
	});

	it("removes a deleted video's caption files with the rest of its folder", async () => {
		const removed = await deleteDeveloperVideoObjects(
			developerVideoPrefix(VIDEO),
		);

		expect(removed).toBe(6);
		expect([...store.keys].sort()).toEqual([
			"developer/app-1/transcripts/tr-1/result.json",
			videoCaptionsKey(OTHER, "en"),
		]);
	});

	it("leaves caption files alone when an encode's unused outputs are cleaned up", async () => {
		await deleteDeveloperVideoObjects(ENCODE, (key) =>
			key.startsWith(`${ENCODE}out-1/`),
		);

		expect(store.keys.has(`${ENCODE}out-0/hls/master.m3u8`)).toBe(false);
		expect(store.keys.has(videoCaptionsKey(VIDEO, "en"))).toBe(true);
		expect(store.keys.has(videoCaptionsKey(VIDEO, "de"))).toBe(true);
	});
});
