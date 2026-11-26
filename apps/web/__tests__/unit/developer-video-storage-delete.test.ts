import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	pages: [] as {
		Contents?: { Key?: string }[];
		IsTruncated?: boolean;
		NextContinuationToken?: string;
	}[],
	listObjects: vi.fn(),
	deleteObjects: vi.fn(),
}));

vi.mock("@cap/web-backend/src/S3Buckets/index", async () => {
	const { Effect, Layer, Context } = await import("effect");
	class S3Buckets extends Context.Tag("S3Buckets")<S3Buckets, object>() {
		static Default = Layer.succeed(S3Buckets, {});
		static getBucketAccess = () =>
			Effect.succeed([
				{
					listObjects: mocks.listObjects,
					deleteObjects: mocks.deleteObjects,
				},
			]);
	}
	return { S3Buckets };
});

const { deleteDeveloperVideoObjects } = await import(
	"@/lib/developer-video-storage"
);

beforeEach(() => {
	mocks.pages = [];
	mocks.listObjects.mockReset();
	mocks.listObjects.mockImplementation(() =>
		Effect.succeed(mocks.pages.shift() ?? { Contents: [] }),
	);
	mocks.deleteObjects.mockReset();
	mocks.deleteObjects.mockImplementation(() => Effect.succeed(Option.some({})));
});

describe("developer video object delete", () => {
	it("deletes every page under the prefix except kept keys", async () => {
		mocks.pages = [
			{
				Contents: [
					{ Key: "developer/app-1/video-1/video" },
					{ Key: "developer/app-1/video-1/e/old/hls/1080p.m4s" },
				],
				IsTruncated: true,
				NextContinuationToken: "next",
			},
			{ Contents: [{ Key: "developer/app-1/video-1/e/new/video.mp4" }] },
		];

		const removed = await deleteDeveloperVideoObjects(
			"developer/app-1/video-1/",
			(key) => key.endsWith("/video"),
		);

		expect(removed).toBe(2);
		expect(mocks.listObjects.mock.calls[1]?.[0]).toMatchObject({
			continuationToken: "next",
		});
		expect(mocks.deleteObjects.mock.calls).toEqual([
			[[{ Key: "developer/app-1/video-1/e/old/hls/1080p.m4s" }]],
			[[{ Key: "developer/app-1/video-1/e/new/video.mp4" }]],
		]);
	});

	it("fails when storage reports a key it could not delete", async () => {
		mocks.pages = [{ Contents: [{ Key: "developer/app-1/video-1/video" }] }];
		mocks.deleteObjects.mockImplementation(() =>
			Effect.succeed(
				Option.some({ Errors: [{ Key: "developer/app-1/video-1/video" }] }),
			),
		);

		await expect(
			deleteDeveloperVideoObjects("developer/app-1/video-1/"),
		).rejects.toThrow("Failed to delete 1");
	});

	it.each([
		"",
		"developer/",
		"developer/app-1/",
		"developer/app-1/video-1",
		"developer/app-1/video-1/encode/output/",
		"other/app-1/video-1/",
	])("refuses to delete under %j", async (prefix) => {
		await expect(deleteDeveloperVideoObjects(prefix)).rejects.toThrow(
			"Refusing",
		);
		expect(mocks.listObjects).not.toHaveBeenCalled();
	});
});
