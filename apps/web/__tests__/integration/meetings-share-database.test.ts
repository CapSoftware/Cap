import { randomUUID } from "node:crypto";
import * as Db from "@cap/database/schema";
import { eq, inArray } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import type { Effect } from "effect";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	database: undefined as unknown,
	storageListed: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database")>()),
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@cap/database/video-sharing-default", () => ({
	getNewVideoPublic: async (orgId: string) => !orgId.startsWith("private"),
}));
vi.mock("@cap/web-backend/src/Storage/index", async () => {
	const { Effect } = await import("effect");
	class Storage extends Effect.Service<Storage>()("Storage", {
		sync: () => ({
			getAccessForVideo: () =>
				Effect.succeed([
					{
						listObjects: ({ prefix }: { prefix: string }) => {
							fixture.storageListed.push(prefix);
							return Effect.succeed({ Contents: [] });
						},
						deleteObjects: () => Effect.void,
					},
				]),
		}),
	}) {}
	return { Storage };
});
vi.mock("@cap/web-backend/src/Tinybird/index", async () => {
	const { Effect } = await import("effect");
	class Tinybird extends Effect.Service<Tinybird>()("Tinybird", {
		sync: () => ({}),
	}) {}
	return { Tinybird };
});
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	const { Videos } = await import("@cap/web-backend");
	return {
		runPromise: <A, E>(effect: Effect.Effect<A, E, never>) =>
			Effect.runPromise(
				effect.pipe(Effect.provide(Videos.Default)) as Effect.Effect<
					A,
					E,
					never
				>,
			),
	};
});

const share = await import("@/lib/meetings/share");
const { meetingShareRequestSchema } = await import("@/lib/meetings/schemas");

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const database = () => fixture.database as MySql2Database;
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);

type ShareUser = Parameters<typeof share.upsertSharedNote>[0];

const createOrg = async (ownerId: string, prefix = "") => {
	const orgId = `${prefix}${id()}`.slice(0, 15);
	await database()
		.insert(Db.organizations)
		.values({
			id: orgId as never,
			name: "Team",
			ownerId: ownerId as never,
		});
	return orgId;
};

const createUser = async (prefix = "") => {
	const userId = id();
	const orgId = await createOrg(userId, prefix);
	await database()
		.insert(Db.users)
		.values({
			id: userId as never,
			email: `${userId}@example.com`,
			name: "Alex Morgan",
			activeOrganizationId: orgId as never,
			defaultOrgId: orgId as never,
		});
	const [user] = await database()
		.select()
		.from(Db.users)
		.where(eq(Db.users.id, userId as never));
	return { user: user as unknown as ShareUser, orgId };
};

const note = (overrides: Record<string, unknown> = {}) =>
	meetingShareRequestSchema.parse({
		documentId: `doc-${id()}`,
		title: "Weekly sync",
		summaryMarkdown: "## Summary\n\nShip the export fix on **Monday**.",
		notesMarkdown: "- [ ] Email the list",
		transcript: [{ speaker: " Sam ", startMs: 1_000, text: " Morning. " }],
		participants: ["Sam", " Sam ", "Priya", ""],
		startedAt: "2026-11-27T09:00:00Z",
		durationSeconds: 1_934,
		...overrides,
	});

const capRow = async (videoId: string) => {
	const [row] = await database()
		.select()
		.from(Db.videos)
		.where(eq(Db.videos.id, videoId as never));
	return row;
};

const noteRow = async (videoId: string) => {
	const [row] = await database()
		.select()
		.from(Db.videoNotes)
		.where(eq(Db.videoNotes.videoId, videoId as never));
	return row;
};

const saved = async (user: ShareUser, input: ReturnType<typeof note>) => {
	const result = await share.upsertSharedNote(user, input);
	if (typeof result === "string") throw new Error(result);
	return result;
};

describe.runIf(Boolean(databaseUrl))("shared notes in MySQL", () => {
	let pool: Pool;

	beforeAll(async () => {
		pool = createPool({ uri: databaseUrl, connectionLimit: 12 });
		fixture.database = drizzle(pool);
	});

	afterAll(async () => {
		await pool?.end();
	});

	it("creates a note cap with the organization's default access", async () => {
		const { user, orgId } = await createUser();
		const input = note();

		const result = await saved(user, input);

		expect(result).toMatchObject({ orgId, created: true });
		expect(await capRow(result.id)).toMatchObject({
			ownerId: user.id,
			orgId,
			name: "Weekly sync",
			isNote: true,
			isScreenshot: false,
			public: true,
			password: null,
			duration: 1_934,
			source: { type: "local" },
			transcriptionStatus: "SKIPPED",
			bucket: null,
		});
		expect(await noteRow(result.id)).toMatchObject({
			ownerId: user.id,
			documentId: input.documentId,
			excerpt: "Ship the export fix on Monday.",
			summaryMarkdown: "## Summary\n\nShip the export fix on **Monday**.",
			notesMarkdown: "- [ ] Email the list",
			transcript: [{ speaker: "Sam", startMs: 1_000, text: "Morning." }],
			participants: ["Sam", "Priya"],
			meetingStartedAt: new Date("2026-11-27T09:00:00Z"),
		});
	});

	it("follows an organization that keeps new caps private", async () => {
		const { user } = await createUser("private");

		const result = await saved(user, note());

		expect(await capRow(result.id)).toMatchObject({ public: false });
	});

	it("shares into the requested organization only when the user belongs to it", async () => {
		const { user, orgId } = await createUser();
		const second = await createOrg(user.id);
		const { orgId: foreign } = await createUser();

		expect(await saved(user, note({ orgId: second }))).toMatchObject({
			orgId: second,
		});
		expect(await saved(user, note({ orgId: foreign }))).toMatchObject({
			orgId,
		});
	});

	it("updates the same link when the document is shared again", async () => {
		const { user } = await createUser();
		const input = note();
		const first = await saved(user, input);
		await database()
			.update(Db.videos)
			.set({ public: false, folderId: "folder-1" as never })
			.where(eq(Db.videos.id, first.id));

		const second = await saved(user, {
			...input,
			title: "Weekly sync, edited",
			summaryMarkdown: "Moved to Tuesday.",
			notesMarkdown: "",
			transcript: undefined,
			participants: [],
			startedAt: undefined,
			durationSeconds: undefined,
		});

		expect(second).toMatchObject({ id: first.id, created: false });
		expect(await capRow(first.id)).toMatchObject({
			name: "Weekly sync, edited",
			duration: null,
			public: false,
			folderId: "folder-1",
		});
		expect(await noteRow(first.id)).toMatchObject({
			excerpt: "Moved to Tuesday.",
			summaryMarkdown: "Moved to Tuesday.",
			notesMarkdown: null,
			transcript: null,
			participants: [],
			meetingStartedAt: null,
		});
	});

	it("keeps one link when the same document is shared at the same moment", async () => {
		const { user } = await createUser();
		const input = note();

		const results = await Promise.all(
			Array.from({ length: 6 }, () => saved(user, input)),
		);

		expect(new Set(results.map((result) => result.id)).size).toBe(1);
		expect(results.filter((result) => result.created)).toHaveLength(1);
		const caps = await database()
			.select({ id: Db.videos.id })
			.from(Db.videos)
			.where(eq(Db.videos.ownerId, user.id));
		expect(caps).toHaveLength(1);
	});

	it("gives two people their own link for the same document id", async () => {
		const [first, second] = await Promise.all([createUser(), createUser()]);
		const input = note();

		const mine = await saved(first.user, input);
		const theirs = await saved(second.user, input);

		expect(mine.id).not.toBe(theirs.id);
		expect([mine.created, theirs.created]).toEqual([true, true]);
	});

	it("stops sharing by removing the cap and its content", async () => {
		const { user } = await createUser();
		const input = note();
		const { id: videoId } = await saved(user, input);

		expect(await share.deleteSharedNote(user, input.documentId)).toBe(true);

		expect(await capRow(videoId)).toBeUndefined();
		expect(await noteRow(videoId)).toBeUndefined();
		expect(fixture.storageListed).toContain(`${user.id}/${videoId}/`);
		expect(await share.deleteSharedNote(user, input.documentId)).toBe(false);
		expect(await saved(user, input)).toMatchObject({ created: true });
	});

	it("does not let one person stop another's share of the same document id", async () => {
		const [owner, other] = await Promise.all([createUser(), createUser()]);
		const input = note();
		const { id: videoId } = await saved(owner.user, input);

		expect(await share.deleteSharedNote(other.user, input.documentId)).toBe(
			false,
		);

		expect(await noteRow(videoId)).toBeDefined();
	});

	it("leaves a transferred cap to its new owner", async () => {
		const [owner, other] = await Promise.all([createUser(), createUser()]);
		const input = note();
		const { id: videoId } = await saved(owner.user, input);
		await database()
			.update(Db.videos)
			.set({ ownerId: other.user.id })
			.where(eq(Db.videos.id, videoId));

		expect(await share.upsertSharedNote(owner.user, input)).toBe("conflict");
		expect(await share.deleteSharedNote(owner.user, input.documentId)).toBe(
			false,
		);
		expect(await noteRow(videoId)).toMatchObject({
			summaryMarkdown: input.summaryMarkdown,
		});
	});

	it("replaces content left behind without its cap", async () => {
		const { user } = await createUser();
		const input = note();
		const first = await saved(user, input);
		const connection = await pool.getConnection();
		try {
			await connection.query("SET FOREIGN_KEY_CHECKS = 0");
			await connection.query("DELETE FROM videos WHERE id = ?", [first.id]);
		} finally {
			await connection.query("SET FOREIGN_KEY_CHECKS = 1");
			connection.release();
		}

		const second = await saved(user, input);

		expect(second.created).toBe(true);
		expect(second.id).not.toBe(first.id);
		const rows = await database()
			.select({ videoId: Db.videoNotes.videoId })
			.from(Db.videoNotes)
			.where(inArray(Db.videoNotes.videoId, [first.id, second.id]));
		expect(rows).toEqual([{ videoId: second.id }]);
	});
});
