import {
	Comment,
	CurrentUser,
	Organisation,
	User,
	Video,
} from "@cap/web-domain";
import { drizzle, type RemoteCallback } from "drizzle-orm/mysql-proxy";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ database: vi.fn(), sendEmail: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({ db: mocks.database }));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: mocks.sendEmail }));

vi.mock("@cap/web-backend/src/S3Buckets/index.ts", async () => {
	const { Effect } = await import("effect");
	class S3Buckets extends Effect.Service<S3Buckets>()("S3Buckets", {
		succeed: {
			getBucketAccess: () =>
				Effect.succeed([
					{ listObjects: () => Effect.succeed({ Contents: [] }) },
				] as const),
		},
	}) {}
	return { S3Buckets };
});
vi.mock("@cap/web-backend/src/ImageUploads/index.ts", async () => {
	const { Effect } = await import("effect");
	class ImageUploads extends Effect.Service<ImageUploads>()("ImageUploads", {
		succeed: {},
	}) {}
	return { ImageUploads };
});
vi.mock("@cap/web-backend/src/Tinybird/index.ts", async () => {
	const { Effect } = await import("effect");
	class Tinybird extends Effect.Service<Tinybird>()("Tinybird", {
		succeed: { deleteData: () => Effect.void },
	}) {}
	return { Tinybird };
});

import { Database } from "@cap/web-backend/src/Database";
import { ImageUploads } from "@cap/web-backend/src/ImageUploads";
import { Organisations } from "@cap/web-backend/src/Organisations";
import { OrganisationsPolicy } from "@cap/web-backend/src/Organisations/OrganisationsPolicy";
import { S3Buckets } from "@cap/web-backend/src/S3Buckets";
import { Tinybird } from "@cap/web-backend/src/Tinybird";
import { VideosRepo } from "@cap/web-backend/src/Videos/VideosRepo";
import {
	createAnonymousViewNotification,
	createNotification,
} from "@/lib/Notification";

const videoId = Video.VideoId.make("video");

function fixture(hasVideo = true) {
	let videoExists = hasVideo;
	const entries: unknown[] = [];
	let beforeNotificationWrite: (() => Promise<void>) | undefined;
	let beforeInsert: (() => Promise<void>) | undefined;
	let lockTail = Promise.resolve();
	const queries: string[] = [];
	const queryFor = () => {
		let release: (() => void) | undefined;
		const lock = async () => {
			if (release) return;
			const previous = lockTail;
			lockTail = new Promise<void>((resolve) => {
				release = resolve;
			});
			await previous;
		};
		const query: RemoteCallback = async (sql, params) => {
			queries.push(sql);
			if (sql.startsWith("select") && sql.includes("from `videos`")) {
				if (sql.endsWith("for update")) await lock();
				if (!videoExists) return { rows: [] };
				if (sql.includes("`bucket`"))
					return { rows: [[videoId, "owner", null, null]] };
				if (sql.includes("inner join"))
					return { rows: [[videoId, "owner", "org", null]] };
				if (sql.startsWith("select `ownerId`")) return { rows: [["owner"]] };
				if (sql.startsWith("select `id` from")) return { rows: [[videoId]] };
				return { rows: [[videoId, "owner"]] };
			}
			if (sql.startsWith("select") && sql.includes("from `organizations`"))
				return { rows: sql.includes("left join") ? [] : [["org", "owner"]] };
			if (
				sql.startsWith("select") &&
				!sql.includes("from `users`") &&
				!sql.includes("from `comments`") &&
				!sql.includes("from `notifications`")
			)
				return { rows: [] };
			if (sql.startsWith("select") && sql.includes("from `users`")) {
				return {
					rows: sql.startsWith("select `id`")
						? [["owner", "org", null]]
						: [[null, "org"]],
				};
			}
			if (sql.startsWith("select") && sql.includes("from `comments`"))
				return { rows: [["parent-author"]] };
			if (sql.startsWith("select") && sql.includes("from `notifications`")) {
				if (!sql.includes("`dedupKey`")) await beforeNotificationWrite?.();
				return { rows: sql.includes("COUNT(*)") ? [[0]] : [] };
			}
			if (sql.startsWith("insert into `notifications`")) {
				await beforeInsert?.();
				entries.push(params);
			}
			if (sql.startsWith("delete from `notifications`")) entries.length = 0;
			if (sql.startsWith("delete from `videos`")) {
				await lock();
				videoExists = false;
			}
			return { rows: [{ affectedRows: 1, insertId: 0 }] };
		};
		return { query, unlock: () => release?.() };
	};
	const client = drizzle(queryFor().query);
	const database = Object.assign(client, {
		transaction: async <T>(operation: (tx: typeof client) => Promise<T>) => {
			const connection = queryFor();
			try {
				return await operation(drizzle(connection.query));
			} finally {
				connection.unlock();
			}
		},
	});
	mocks.database.mockReturnValue(database);
	return {
		entries,
		queries,
		beforeInsert: (callback: () => Promise<void>) => {
			beforeInsert = callback;
		},
		beforeNotificationWrite: (callback: () => Promise<void>) => {
			beforeNotificationWrite = callback;
		},
	};
}

const types = ["view", "comment", "reaction", "reply", "anon_view"] as const;
function notify(type: (typeof types)[number]) {
	if (type === "anon_view")
		return createAnonymousViewNotification({
			videoId,
			sessionId: "session",
			anonName: "Anonymous Otter",
			location: null,
		});
	if (type === "view")
		return createNotification({ type, videoId, authorId: "viewer" });
	return createNotification({
		type,
		videoId,
		authorId: "viewer",
		comment: { id: "comment", content: "hello" },
		parentCommentId: Comment.CommentId.make("parent"),
	});
}

function deleteRecording() {
	return Effect.runPromise(
		Effect.flatMap(VideosRepo, (repo) => repo.delete(videoId)).pipe(
			Effect.provide(VideosRepo.Default),
		),
	);
}

function deleteOrganisation() {
	return Effect.runPromise(
		Effect.flatMap(Organisations, (organisations) =>
			organisations.softDelete(Organisation.OrganisationId.make("org")),
		).pipe(
			Effect.provide(Organisations.DefaultWithoutDependencies),
			Effect.provide(ImageUploads.Default),
			Effect.provide(S3Buckets.Default),
			Effect.provide(Tinybird.Default),
			Effect.provide(Database.Default),
			Effect.provideService(
				OrganisationsPolicy,
				OrganisationsPolicy.make({
					isMember: () => Effect.void,
					isOwner: () => Effect.void,
					isAdminOrOwner: () => Effect.void,
				}),
			),
			Effect.provideService(CurrentUser, {
				id: User.UserId.make("owner"),
				email: "owner@example.test",
				activeOrganizationId: Organisation.OrganisationId.make("org"),
				iconUrlOrKey: Option.none(),
			}),
		),
	);
}

describe("notifications during recording deletion", () => {
	it.each(types)(
		"does not leave a %s notification when deletion wins after the initial read",
		async (type) => {
			const database = fixture();
			database.beforeNotificationWrite(deleteRecording);

			await expect(notify(type)).resolves.toBeUndefined();

			expect(database.entries).toEqual([]);
			expect(mocks.sendEmail).not.toHaveBeenCalled();
		},
	);

	it.each(types)(
		"cleans up a %s notification when its insert wins before deletion",
		async (type) => {
			const database = fixture();
			await notify(type);
			expect(database.entries).toHaveLength(1);

			await deleteRecording();

			expect(database.entries).toEqual([]);
			const lockIndex = database.queries.findIndex((sql) =>
				sql.endsWith("for update"),
			);
			const insertIndex = database.queries.findIndex((sql) =>
				sql.startsWith("insert into `notifications`"),
			);
			expect(lockIndex).toBeGreaterThanOrEqual(0);
			expect(lockIndex).toBeLessThan(insertIndex);
			const deleteLockIndex = database.queries.findLastIndex((sql) =>
				sql.endsWith("for update"),
			);
			const deleteIndex = database.queries.findIndex((sql) =>
				sql.startsWith("delete from `notifications`"),
			);
			expect(deleteLockIndex).toBeGreaterThan(insertIndex);
			expect(deleteLockIndex).toBeLessThan(deleteIndex);
		},
	);

	it("waits for an in-flight notification transaction before deleting feedback", async () => {
		const database = fixture();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const beforeInsert = vi.fn(() => gate);
		database.beforeInsert(beforeInsert);
		const notification = notify("view");
		await vi.waitFor(() => expect(beforeInsert).toHaveBeenCalledOnce());
		const deletion = deleteRecording();
		await vi.waitFor(() =>
			expect(
				database.queries.filter((sql) => sql.endsWith("for update")),
			).toHaveLength(2),
		);
		expect(
			database.queries.some((sql) =>
				sql.startsWith("delete from `notifications`"),
			),
		).toBe(false);
		if (!release) throw new Error("Missing insert resolver");
		release();
		await Promise.all([notification, deletion]);
		expect(database.entries).toEqual([]);
	});
});

describe("notifications during organization deletion", () => {
	it.each(types)(
		"waits for an in-flight %s notification before deleting feedback",
		async (type) => {
			const database = fixture();
			const { promise: gate, resolve: release } = Promise.withResolvers<void>();
			const beforeInsert = vi.fn(() => gate);
			database.beforeInsert(beforeInsert);
			const notification = notify(type);
			await vi.waitFor(() => expect(beforeInsert).toHaveBeenCalledOnce());
			const deletion = deleteOrganisation();
			try {
				await vi.waitFor(() =>
					expect(
						database.queries.some(
							(sql) =>
								(sql.includes("from `videos`") &&
									sql.endsWith("for update") &&
									sql.includes(" in (")) ||
								sql.startsWith("delete from `comments`"),
						),
					).toBe(true),
				);
				expect(
					database.queries.some(
						(sql) =>
							sql.startsWith("delete from `comments`") ||
							sql.startsWith("delete from `notifications`"),
					),
				).toBe(false);
			} finally {
				release();
				await Promise.all([notification, deletion]);
			}
			expect(database.entries).toEqual([]);
		},
	);

	it.each(types)(
		"skips a %s notification when organization deletion wins after the initial read",
		async (type) => {
			const database = fixture();
			database.beforeNotificationWrite(deleteOrganisation);

			await expect(notify(type)).resolves.toBeUndefined();

			expect(database.entries).toEqual([]);
			expect(mocks.sendEmail).not.toHaveBeenCalled();
		},
	);

	it("deletes an organization without recordings", async () => {
		const database = fixture(false);

		await expect(deleteOrganisation()).resolves.toBeUndefined();

		expect(database.queries.some((sql) => sql.includes(" in ()"))).toBe(false);
		expect(database.queries).toContain(
			"delete from `organizations` where `organizations`.`id` = ?",
		);
	});
});
