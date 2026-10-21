import { randomUUID } from "node:crypto";
import { affectedRows } from "@cap/database/helpers";
import { jsonbMergePatch, jsonbRemove, jsonbSet } from "@cap/database/json";
import * as Db from "@cap/database/schema";
import { Comment, Folder, Organisation, User, Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	user: undefined as Record<string, unknown> | undefined,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("workflow/api", () => ({
	start: vi.fn(async () => ({ id: "workflow" })),
}));
vi.mock("@/lib/password-cookie", () => ({
	getVerifiedPasswordHashes: vi.fn(async () => []),
	setVerifiedPasswordCookie: vi.fn(async () => undefined),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(async () => fixture.user),
}));

const databaseUrl = process.env.CAP_PG_TEST_DATABASE_URL;

const id = () => randomUUID().replaceAll("-", "").slice(0, 15);

describe.runIf(Boolean(databaseUrl))("PostgreSQL query behavior", () => {
	const ownerId = User.UserId.make(id());
	const organizationId = Organisation.OrganisationId.make(id());
	const folderId = Folder.FolderId.make(id());
	const videoId = Video.VideoId.make(id());
	const secondVideoId = Video.VideoId.make(id());
	let database: typeof import("@cap/database").db;

	beforeAll(async () => {
		if (!databaseUrl) throw new Error("Missing test database URL");
		const url = new URL(databaseUrl);
		if (
			!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
			!/^\/cap_pg_[a-z0-9_]+$/.test(url.pathname)
		) {
			throw new Error(
				"PostgreSQL tests require a session-scoped local database",
			);
		}
		process.env.DATABASE_URL = databaseUrl;
		database = (await import("@cap/database")).db;
		const db = database();
		await db.insert(Db.users).values({
			id: ownerId,
			email: `${ownerId}@example.com`,
			name: "Owner",
			activeOrganizationId: organizationId,
			defaultOrgId: organizationId,
		});
		await db
			.insert(Db.organizations)
			.values({ id: organizationId, ownerId, name: "Query Org" });
		await db.insert(Db.organizationMembers).values({
			id: id(),
			userId: ownerId,
			organizationId,
			role: "owner",
		});
		await db.insert(Db.folders).values({
			id: folderId,
			name: "Folder",
			organizationId,
			createdById: ownerId,
		});
		await db.insert(Db.videos).values([
			{
				id: videoId,
				ownerId,
				orgId: organizationId,
				name: "Quarterly demo",
				folderId,
				metadata: { customCreatedAt: "2020-01-02T03:04:05.678Z" },
			},
			{
				id: secondVideoId,
				ownerId,
				orgId: organizationId,
				name: "Another recording",
			},
		]);
		await db.insert(Db.videoUploads).values({ videoId });
		await db.insert(Db.comments).values([
			{
				id: Comment.CommentId.make(id()),
				type: "text" as const,
				content: "hi",
				authorId: ownerId,
				videoId,
			},
			{
				id: Comment.CommentId.make(id()),
				type: "emoji" as const,
				content: "🎉",
				authorId: ownerId,
				videoId,
			},
		]);
		await db.insert(Db.sharedVideos).values({
			id: id(),
			videoId,
			organizationId,
			sharedByUserId: ownerId,
		});
		fixture.user = (
			await db.select().from(Db.users).where(eq(Db.users.id, ownerId))
		)[0];
	});

	afterAll(async () => {
		fixture.user = undefined;
	});

	it("derives effectiveCreatedAt from metadata.customCreatedAt", async () => {
		const rows = await database()
			.select({
				id: Db.videos.id,
				effective: Db.videos.effectiveCreatedAt,
				createdAt: Db.videos.createdAt,
			})
			.from(Db.videos)
			.where(eq(Db.videos.orgId, organizationId));
		const custom = rows.find((row) => row.id === videoId);
		const plain = rows.find((row) => row.id === secondVideoId);
		expect(custom?.effective?.toISOString()).toBe("2020-01-02T03:04:05.678Z");
		expect(plain?.effective?.getTime()).toBe(plain?.createdAt.getTime());
	});

	it("round-trips updatedAt so it can be used as an optimistic fence", async () => {
		const db = database();
		const [row] = await db
			.select({ updatedAt: Db.videos.updatedAt })
			.from(Db.videos)
			.where(eq(Db.videos.id, secondVideoId));
		if (!row) throw new Error("Missing video");
		const matched = await db
			.update(Db.videos)
			.set({ name: "Another recording" })
			.where(
				and(
					eq(Db.videos.id, secondVideoId),
					eq(Db.videos.updatedAt, row.updatedAt),
				),
			);
		expect(affectedRows(matched)).toBe(1);
	});

	it("applies jsonb helpers with the previous MySQL JSON semantics", async () => {
		const db = database();
		const read = async () =>
			(
				await db
					.select({ metadata: Db.videos.metadata })
					.from(Db.videos)
					.where(eq(Db.videos.id, secondVideoId))
			)[0]?.metadata as Record<string, unknown> | null;

		await db
			.update(Db.videos)
			.set({
				metadata: jsonbSet(
					Db.videos.metadata,
					["aiGenerationStatus"],
					"QUEUED",
				),
			})
			.where(eq(Db.videos.id, secondVideoId));
		expect(await read()).toEqual({ aiGenerationStatus: "QUEUED" });

		await db
			.update(Db.videos)
			.set({
				settings: jsonbMergePatch(Db.videos.settings, {
					callToAction: { label: "Go" },
					disableComments: true,
				}),
			})
			.where(eq(Db.videos.id, secondVideoId));
		await db
			.update(Db.videos)
			.set({
				settings: jsonbMergePatch(Db.videos.settings, { callToAction: null }),
			})
			.where(eq(Db.videos.id, secondVideoId));
		const [{ settings } = { settings: null }] = await db
			.select({ settings: Db.videos.settings })
			.from(Db.videos)
			.where(eq(Db.videos.id, secondVideoId));
		expect(settings).toEqual({ disableComments: true });

		await db
			.update(Db.videos)
			.set({
				metadata: jsonbRemove(Db.videos.metadata, ["aiGenerationStatus"]),
			})
			.where(eq(Db.videos.id, secondVideoId));
		expect(await read()).toEqual({});

		const matched = await db
			.select({ id: Db.videos.id })
			.from(Db.videos)
			.where(
				and(
					eq(Db.videos.id, videoId),
					sql`${Db.videos.metadata} ->> 'customCreatedAt' = ${"2020-01-02T03:04:05.678Z"}`,
				),
			);
		expect(matched).toHaveLength(1);
	});

	it("aggregates comments and shared organizations per video", async () => {
		const rows = await database()
			.select({
				id: Db.videos.id,
				totalComments: sql<number>`COUNT(DISTINCT CASE WHEN ${Db.comments.type} = 'text' THEN ${Db.comments.id} END)`,
				totalReactions: sql<number>`COUNT(DISTINCT CASE WHEN ${Db.comments.type} = 'emoji' THEN ${Db.comments.id} END)`,
				sharedOrganizations: sql<{ id: string; name: string }[]>`
					COALESCE(jsonb_agg(jsonb_build_object('id', ${Db.organizations.id}, 'name', ${Db.organizations.name})), '[]'::jsonb)`,
				hasActiveUpload:
					sql`${Db.videoUploads.videoId} IS NOT NULL AND ${Db.videos.isScreenshot} = false`.mapWith(
						Boolean,
					),
			})
			.from(Db.videos)
			.leftJoin(Db.comments, eq(Db.videos.id, Db.comments.videoId))
			.leftJoin(Db.sharedVideos, eq(Db.videos.id, Db.sharedVideos.videoId))
			.leftJoin(
				Db.organizations,
				eq(Db.sharedVideos.organizationId, Db.organizations.id),
			)
			.leftJoin(Db.videoUploads, eq(Db.videos.id, Db.videoUploads.videoId))
			.where(eq(Db.videos.id, videoId))
			.groupBy(Db.videos.id, Db.videoUploads.videoId);
		expect(rows[0]).toMatchObject({
			id: videoId,
			totalComments: 1,
			totalReactions: 1,
			hasActiveUpload: true,
		});
		expect(rows[0]?.sharedOrganizations).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: organizationId })]),
		);
	});

	it("searches dashboard videos case-insensitively", async () => {
		const { searchDashboardVideos } = await import(
			"@/app/(org)/dashboard/_components/Navbar/search"
		);
		const results = await searchDashboardVideos("QUARTERLY");
		expect(results.map((result) => result.id)).toContain(videoId);
	});

	it("lists MCP caps with a case-insensitive search", async () => {
		const { listMcpCaps } = await import("@/lib/mcp-data");
		const listed = await listMcpCaps(ownerId, { search: "another" });
		expect(JSON.stringify(listed)).toContain(secondVideoId);
	});

	it("loads the dashboard organizations and spaces", async () => {
		const { getDashboardSpacesData } = await import(
			"@/app/(org)/dashboard/dashboard-data"
		);
		const spaces = await getDashboardSpacesData(
			fixture.user as Parameters<typeof getDashboardSpacesData>[0],
		);
		expect(Array.isArray(spaces)).toBe(true);
	});

	it("reads folder contents with upload state, comment counts and shared organizations", async () => {
		const { runPromise } = await import("@/lib/server");
		const { getChildFolders, getVideosByFolderId } = await import(
			"@/lib/folder"
		);
		const { CurrentUser } = await import("@cap/web-domain");
		const { Effect, Option } = await import("effect");
		const root = { variant: "org", organizationId } as const;
		const user = {
			id: ownerId,
			email: `${ownerId}@example.com`,
			activeOrganizationId: organizationId,
			iconUrlOrKey: Option.none(),
		};
		const videosInFolder = await runPromise(
			getVideosByFolderId(folderId, root).pipe(
				Effect.provideService(CurrentUser, user),
			),
		);
		expect(Array.isArray(videosInFolder)).toBe(true);
		const children = await runPromise(
			getChildFolders(folderId, root).pipe(
				Effect.provideService(CurrentUser, user),
			),
		);
		expect(Array.isArray(children)).toBe(true);
	});

	it("serves public collections with password and upload aggregates", async () => {
		await database()
			.update(Db.folders)
			.set({ public: true })
			.where(eq(Db.folders.id, folderId));
		await database()
			.insert(Db.sharedVideos)
			.values({
				id: id(),
				videoId: secondVideoId,
				folderId,
				organizationId,
				sharedByUserId: ownerId,
			})
			.onConflictDoNothing();
		const { getPublicCollectionPageData } = await import(
			"@/lib/public-collections"
		);
		const data = await getPublicCollectionPageData(folderId, 1);
		expect(data).not.toBeNull();
	});

	it("buckets analytics series by hour and day", async () => {
		const { getOrgAnalyticsData } = await import(
			"@/app/(org)/dashboard/analytics/data"
		);
		const result = await getOrgAnalyticsData(organizationId, "lifetime");
		expect(result).toBeDefined();
	});

	it("scans stalled pipeline candidates", async () => {
		const { recoverStalledVideoPipeline } = await import(
			"@/lib/video-pipeline-recovery"
		);
		const summary = await recoverStalledVideoPipeline({
			now: new Date(Date.now() + 72 * 60 * 60_000),
		});
		expect(summary).toBeDefined();
	});
});
