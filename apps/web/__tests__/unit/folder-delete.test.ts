import { CurrentUser, Folder, Organisation, User } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { Database } from "../../../../packages/web-backend/src/Database";
import { Folders } from "../../../../packages/web-backend/src/Folders";
import { FoldersPolicy } from "../../../../packages/web-backend/src/Folders/FoldersPolicy";
import { FoldersRepo } from "../../../../packages/web-backend/src/Folders/FoldersRepo";

const mocks = vi.hoisted(() => ({
	query:
		vi.fn<(sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>>(),
}));

vi.mock("../../../../packages/web-backend/src/Database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const { Effect } = await import("effect");
	const client = drizzle(mocks.query);
	class Database extends Effect.Service<Database>()("Database", {
		succeed: {
			use: <T>(callback: (db: typeof client) => Promise<T>) =>
				Effect.promise(() => callback(client)),
		},
	}) {}
	return { Database };
});

const organizationId = Organisation.OrganisationId.make("org-1");
const folderId = Folder.FolderId.make("removed");
const childId = Folder.FolderId.make("child");
const parentId = Folder.FolderId.make("kept-parent");
const relocationSql =
	"update `shared_videos` set `folderId` = ? where (`shared_videos`.`folderId` = ? and `shared_videos`.`organizationId` = ?)";

function setup(parent: Folder.FolderId | null, hasChild = false) {
	mocks.query.mockImplementation(async (sql, params) => {
		if (!sql.startsWith("select")) {
			return { rows: [{ insertId: 0, affectedRows: 1 }] };
		}
		if (sql.includes("where `folders`.`id` = ?")) {
			return {
				rows: [
					[
						folderId,
						"Folder",
						"normal",
						0,
						null,
						organizationId,
						"user-1",
						parent,
						organizationId,
						"2026-01-01 00:00:00",
						"2026-01-01 00:00:00",
					],
				],
			};
		}
		return {
			rows:
				hasChild && params[0] === folderId
					? [[childId, organizationId, folderId, organizationId]]
					: [],
		};
	});
}

function deleteFolder() {
	return Effect.flatMap(Folders, (folders) => folders.delete(folderId)).pipe(
		Effect.provide(Folders.DefaultWithoutDependencies),
		Effect.provideService(
			FoldersPolicy,
			FoldersPolicy.make({
				canCreateIn: () => Effect.void,
				canEdit: () => Effect.void,
			}),
		),
		Effect.provide(FoldersRepo.DefaultWithoutDependencies),
		Effect.provide(Database.Default),
		Effect.provideService(CurrentUser, {
			id: User.UserId.make("user-1"),
			email: "user@example.com",
			activeOrganizationId: organizationId,
			iconUrlOrKey: Option.none(),
		}),
		Effect.runPromise,
	);
}

function mutations() {
	return mocks.query.mock.calls
		.filter(([sql]) => !sql.startsWith("select"))
		.map(([sql, params]) => ({ sql, params }));
}

describe("organization folder deletion", () => {
	it.each([null, parentId])(
		"relocates team videos to %s before removing the folder",
		async (parent) => {
			setup(parent);

			await deleteFolder();

			expect(mutations()).toEqual([
				{ sql: relocationSql, params: [parent, folderId, organizationId] },
				{
					sql: "delete from `folders` where `folders`.`id` = ?",
					params: [folderId],
				},
			]);
		},
	);

	it("preserves organization placement while recursively deleting children", async () => {
		setup(parentId, true);

		await deleteFolder();

		expect(mutations()).toEqual([
			{ sql: relocationSql, params: [folderId, childId, organizationId] },
			{
				sql: "delete from `folders` where `folders`.`id` = ?",
				params: [childId],
			},
			{ sql: relocationSql, params: [parentId, folderId, organizationId] },
			{
				sql: "delete from `folders` where `folders`.`id` = ?",
				params: [folderId],
			},
		]);
	});
});
