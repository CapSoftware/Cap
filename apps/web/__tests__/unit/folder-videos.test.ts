import { Database, ImageUploads } from "@cap/web-backend";
import { Folder, Organisation, Space } from "@cap/web-domain";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVideosByFolderId } from "@/lib/folder";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@cap/web-backend", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const { Effect } = await import("effect");
	const { resolveEffectiveVideoRules } = await import(
		"../../../../packages/web-backend/src/Videos/EffectiveVideoRules"
	);
	const client = drizzle(mocks.query);
	class Database extends Effect.Service<Database>()("Database", {
		succeed: {
			use: <T>(callback: (db: typeof client) => Promise<T>) =>
				Effect.promise(() => callback(client)),
		},
	}) {}
	class ImageUploads extends Effect.Service<ImageUploads>()("ImageUploads", {
		succeed: {
			resolveImageUrl: (key: string) => Effect.succeed(key),
		},
	}) {}
	return { Database, ImageUploads, resolveEffectiveVideoRules };
});

beforeEach(() => {
	mocks.query.mockResolvedValue({ rows: [] });
});

describe.each([
	{ variant: "user" } as const,
	{ variant: "space", spaceId: Space.SpaceId.make("space-1") } as const,
	{
		variant: "org",
		organizationId: Organisation.OrganisationId.make("org-1"),
	} as const,
])("$variant folder videos", (root) => {
	it.each([125.5, null])(
		"preserves a stored duration of %s",
		async (duration) => {
			mocks.query.mockResolvedValueOnce({
				rows: [
					[
						"video-1",
						"owner-1",
						"Product walkthrough",
						"2026-10-23 12:00:00",
						true,
						null,
						{ type: "webMP4" },
						false,
						duration,
						null,
						"org-1",
						0,
						0,
						[],
						"Owner",
						"2026-10-23 12:00:00",
						false,
						false,
					],
				],
			});
			const videos = await getVideosByFolderId(
				Folder.FolderId.make("folder-1"),
				root,
			).pipe(
				Effect.provide(Database.Default),
				Effect.provide(ImageUploads.Default),
				Effect.runPromise,
			);

			expect(videos).toMatchObject([
				{
					id: "video-1",
					source: { type: "webMP4" },
					duration: duration ?? undefined,
					hasActiveUpload: false,
				},
			]);
		},
	);
});
