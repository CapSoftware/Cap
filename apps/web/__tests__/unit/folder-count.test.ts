import { Database } from "@cap/web-backend";
import {
	CurrentUser,
	Folder,
	Organisation,
	Space,
	User,
} from "@cap/web-domain";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getChildFolders } from "@/lib/folder";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@cap/web-backend", async () => {
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

const orgId = Organisation.OrganisationId.make("org-1");
const parentId = Folder.FolderId.make("parent-folder");

const getChildren = (root: Parameters<typeof getChildFolders>[1]) =>
	getChildFolders(parentId, root).pipe(
		Effect.provide(Database.Default),
		Effect.provideService(CurrentUser, {
			id: User.UserId.make("user-1"),
			email: "user@example.com",
			activeOrganizationId: orgId,
			iconUrlOrKey: Option.none(),
		}),
		Effect.runPromise,
	);

beforeEach(() => {
	mocks.query.mockResolvedValue({ rows: [] });
});

describe("subfolder video counts", () => {
	it.each([
		{ root: { variant: "user" } as const, table: "videos", scope: null },
		{
			root: {
				variant: "space",
				spaceId: Space.SpaceId.make("space-1"),
			} as const,
			table: "space_videos",
			scope: "spaceId",
		},
		{
			root: { variant: "org", organizationId: orgId } as const,
			table: "shared_videos",
			scope: "organizationId",
		},
	])(
		"correlates $table counts to the outer folder",
		async ({ root, table, scope }) => {
			await getChildren(root);
			const [query, params] = mocks.query.mock.calls[0] ?? [];
			expect(query).toContain(`\`${table}\`.\`folderId\` = \`folders\`.\`id\``);
			if (scope) {
				expect(query).toContain(`\`${table}\`.\`${scope}\` = ?`);
			}
			expect(params).toContain(parentId);
		},
	);

	it("returns numeric counts when the driver returns COUNT as a string", async () => {
		mocks.query.mockResolvedValueOnce({
			rows: [
				[
					"child-folder",
					"Live Calls",
					"normal",
					0,
					parentId,
					orgId,
					"2026-09-09 00:00:00",
					"2",
				],
			],
		});
		const children = await getChildren({ variant: "user" });
		expect(children[0]?.videoCount).toBe(2);
	});
});
