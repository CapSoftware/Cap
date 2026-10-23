import { PublicCollection as PublicCollectionDomain } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicCollection } from "@/lib/public-collections";
import {
	copyOwnershipMedia,
	planOwnershipTransfer,
	transferredOwnershipFields,
} from "@/lib/recording-ownership-transfer";
import { mediaFixture, ownershipFixture } from "../helpers/ownership-transfer";

type Row = Record<string, unknown>;
type Column = { table: string; field: string };
type Joined = Record<string, Row | undefined>;
type Predicate = (row: Joined) => boolean;
type Table = { tableName: string };
type Expression = { aggregate: string; mapWith: () => Expression };

const state = vi.hoisted(() => ({ rows: {} as Record<string, Row[]> }));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => null,
}));
vi.mock("@/lib/password-cookie", () => ({
	getVerifiedPasswordHashes: async () => [],
}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@cap/web-backend", () => ({ ImageUploads: {} }));
vi.mock("@cap/database/schema", () =>
	Object.fromEntries(
		[
			"comments",
			"folders",
			"organizations",
			"sharedVideos",
			"spaces",
			"spaceVideos",
			"users",
			"videos",
			"videoUploads",
		].map((table) => [
			table,
			new Proxy(
				{ tableName: table },
				{
					get: (target, field) =>
						field === "tableName" ? target.tableName : { table, field },
				},
			),
		]),
	),
);
vi.mock("drizzle-orm", () => {
	const value = (row: Joined, input: unknown) => {
		if (
			input &&
			typeof input === "object" &&
			"table" in input &&
			"field" in input
		) {
			const column = input as Column;
			return row[column.table]?.[column.field];
		}
		return input;
	};
	const sql = Object.assign(
		(strings: TemplateStringsArray): Expression => {
			const expression: Expression = {
				aggregate: strings.join(""),
				mapWith: () => expression,
			};
			return expression;
		},
		{ join: () => ({ aggregate: "", mapWith: () => ({}) }) },
	);
	return {
		sql,
		eq:
			(left: unknown, right: unknown): Predicate =>
			(row) =>
				value(row, left) === value(row, right),
		isNull:
			(column: Column): Predicate =>
			(row) =>
				value(row, column) == null,
		inArray:
			(column: Column, values: unknown[]): Predicate =>
			(row) =>
				values.includes(value(row, column)),
		and:
			(...conditions: Array<Predicate | Expression>): Predicate =>
			(row) =>
				conditions.every((condition) =>
					typeof condition === "function" ? condition(row) : true,
				),
		desc: (column: Column) => column,
	};
});
vi.mock("@cap/database", () => ({
	db: () => ({
		select: (selection: Record<string, Column | Expression>) => ({
			from: (table: Table) => {
				let rows: Joined[] = (state.rows[table.tableName] ?? []).map((row) => ({
					[table.tableName]: row,
				}));
				const join = (table: Table, condition: Predicate, left: boolean) => {
					rows = rows.flatMap((row) => {
						const matches = (state.rows[table.tableName] ?? [])
							.map((item) => ({ ...row, [table.tableName]: item }))
							.filter(condition);
						return matches.length || !left ? matches : [row];
					});
					return query;
				};
				const results = () => {
					if ("count" in selection)
						return [{ count: new Set(rows.map((row) => row.videos?.id)).size }];
					return rows.map((row) =>
						Object.fromEntries(
							Object.entries(selection).map(([field, column]) => [
								field,
								"table" in column
									? row[column.table]?.[column.field]
									: field === "hasPassword" || field === "hasActiveUpload"
										? false
										: 0,
							]),
						),
					);
				};
				const query = Object.assign(Promise.resolve().then(results), {
					innerJoin: (table: Table, condition: Predicate) =>
						join(table, condition, false),
					leftJoin: (table: Table, condition: Predicate) =>
						join(table, condition, true),
					where: (condition: Predicate) => {
						rows = rows.filter(condition);
						return query;
					},
					groupBy: () => {
						rows = [
							...new Map(rows.map((row) => [row.videos?.id, row])).values(),
						];
						return query;
					},
					orderBy: () => query,
					limit: () => query,
					offset: () => query,
				});
				return query;
			},
		}),
	}),
}));

import { getPublicCollectionVideos } from "@/lib/public-collections";

beforeEach(() => {
	state.rows = {
		organizations: [{ id: "test-org", tombstoneAt: null }],
		sharedVideos: [
			{
				videoId: "test-video",
				organizationId: "test-org",
				folderId: "test-folder",
			},
		],
		spaceVideos: [
			{ videoId: "test-video", spaceId: "test-space", folderId: "test-folder" },
		],
		users: [
			{ id: "test-owner", name: "Synthetic owner" },
			{ id: "test-target", name: "Synthetic target" },
		],
	};
});

describe("ownership transfer public collection associations", () => {
	it.each(["personal", "organization", "space"])(
		"preserves actual %s folder listing and count queries",
		async (kind) => {
			const snapshot = ownershipFixture();
			const folder = snapshot.folderAccess?.folders[0];
			if (!folder) throw new Error("Missing synthetic folder");
			folder.public = true;
			folder.spaceId =
				kind === "organization"
					? snapshot.video.orgId
					: kind === "space"
						? ("test-space" as typeof folder.spaceId)
						: null;
			const video = {
				...snapshot.video,
				public: true,
				password: null,
				name: "Synthetic recording",
				createdAt: new Date(0),
				duration: 1,
			};
			state.rows.videos = [video];
			const collection: PublicCollection = {
				id: folder.id,
				kind: "folder",
				name: "Synthetic collection",
				color: "normal",
				description: null,
				spaceId: folder.spaceId,
				organizationId: snapshot.video.orgId,
				organizationName: "Synthetic organization",
				allowedEmailDomain: null,
				passwordHash: null,
				publicPage: { ...PublicCollectionDomain.DEFAULT_PUBLIC_PAGE_SETTINGS },
				organizationIconUrl: null,
				collectionLogoUrl: null,
			};
			const before = await getPublicCollectionVideos(collection, 1, []);
			expect(before.videos.map((item) => item.id)).toEqual(["test-video"]);
			const sharing = structuredClone({
				shared: state.rows.sharedVideos,
				spaces: state.rows.spaceVideos,
			});
			const { store } = mediaFixture();
			const plan = await planOwnershipTransfer(
				snapshot,
				"test-target",
				null,
				store,
			);
			Object.assign(
				video,
				transferredOwnershipFields(plan, await copyOwnershipMedia(plan, store)),
			);
			const after = await getPublicCollectionVideos(collection, 1, []);
			expect(after.videos.map((item) => item.id)).toEqual(
				before.videos.map((item) => item.id),
			);
			expect(after.totalCount).toBe(before.totalCount);
			expect({
				shared: state.rows.sharedVideos,
				spaces: state.rows.spaceVideos,
			}).toEqual(sharing);
			expect(video.folderId).toBe(kind === "personal" ? "test-folder" : null);
			if (kind === "personal") {
				video.folderId = null;
				expect(
					(await getPublicCollectionVideos(collection, 1, [])).totalCount,
				).toBe(0);
			}
		},
	);

	it("holds a request to move out of a public personal collection", async () => {
		const snapshot = ownershipFixture();
		const folder = snapshot.folderAccess?.folders[0];
		if (!folder) throw new Error("Missing synthetic folder");
		folder.public = true;
		const { store } = mediaFixture();
		await expect(
			planOwnershipTransfer(snapshot, "test-target", "test-other", store),
		).rejects.toThrow("UNSUPPORTED");
		expect(store.copyIfAbsent).not.toHaveBeenCalled();
	});
});
