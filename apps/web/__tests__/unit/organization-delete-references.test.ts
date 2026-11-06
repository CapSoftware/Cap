import { CurrentUser, Organisation, User } from "@cap/web-domain";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "../../../../packages/web-backend/src/Database";
import { ImageUploads } from "../../../../packages/web-backend/src/ImageUploads";
import { Organisations } from "../../../../packages/web-backend/src/Organisations";
import { OrganisationsPolicy } from "../../../../packages/web-backend/src/Organisations/OrganisationsPolicy";
import { S3Buckets } from "../../../../packages/web-backend/src/S3Buckets";
import { Tinybird } from "../../../../packages/web-backend/src/Tinybird";

const mocks = vi.hoisted(() => ({
	selectRows: [] as unknown[][],
	updates: [] as { values: Record<string, unknown>; condition: SQL }[],
}));

vi.mock("../../../../packages/web-backend/src/Database", async () => {
	const { Effect } = await import("effect");
	function select() {
		const query = Object.assign(
			Promise.resolve(mocks.selectRows.shift() ?? []),
			{
				from: () => query,
				leftJoin: () => query,
				where: () => query,
				orderBy: () => query,
				limit: () => query,
				for: () => query,
			},
		);
		return query;
	}
	const database = {
		select,
		delete: () => ({ where: async () => undefined }),
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: async (condition: SQL) => {
					mocks.updates.push({ values, condition });
				},
			}),
		}),
	};
	const client = {
		...database,
		transaction: async <T>(callback: (tx: typeof database) => Promise<T>) =>
			callback(database),
	};
	class Database extends Effect.Service<Database>()("Database", {
		succeed: {
			use: <T>(callback: (db: typeof client) => Promise<T>) =>
				Effect.promise(() => callback(client)),
		},
	}) {}
	return { Database };
});

vi.mock("../../../../packages/web-backend/src/ImageUploads", async () => {
	const { Effect } = await import("effect");
	class ImageUploads extends Effect.Service<ImageUploads>()("ImageUploads", {
		succeed: {},
	}) {}
	return { ImageUploads };
});

vi.mock(
	"../../../../packages/web-backend/src/Organisations/OrganisationsPolicy",
	async () => {
		const { Effect } = await import("effect");
		class OrganisationsPolicy extends Effect.Service<OrganisationsPolicy>()(
			"OrganisationsPolicy",
			{ succeed: { isOwner: () => Effect.void } },
		) {}
		return { OrganisationsPolicy };
	},
);

vi.mock("../../../../packages/web-backend/src/S3Buckets", async () => {
	const { Effect } = await import("effect");
	class S3Buckets extends Effect.Service<S3Buckets>()("S3Buckets", {
		succeed: {
			getBucketAccess: () =>
				Effect.succeed([
					{ listObjects: () => Effect.succeed({ Contents: [] }) },
				]),
		},
	}) {}
	return { S3Buckets };
});

vi.mock("../../../../packages/web-backend/src/Tinybird", async () => {
	const { Effect } = await import("effect");
	class Tinybird extends Effect.Service<Tinybird>()("Tinybird", {
		succeed: { deleteData: () => Effect.void },
	}) {}
	return { Tinybird };
});

const deletedOrgId = Organisation.OrganisationId.make("deleted");

async function deleteOrganization(fallback: string | null = "remaining") {
	mocks.selectRows = [
		[{ id: deletedOrgId, ownerId: "owner" }],
		[],
		[{ userId: "member", hasProSeat: false }],
		[],
		[],
		fallback ? [{ id: fallback }] : [],
		fallback ? [{ id: fallback }] : [],
	];
	await Effect.runPromise(
		Effect.flatMap(Organisations, (organizations) =>
			organizations.softDelete(deletedOrgId),
		).pipe(
			Effect.provide(
				Organisations.Default.pipe(
					Layer.provide(
						Layer.mergeAll(
							Database.Default,
							ImageUploads.Default,
							OrganisationsPolicy.Default,
							S3Buckets.Default,
							Tinybird.Default,
						),
					),
				),
			),
			Effect.provideService(CurrentUser, {
				id: User.UserId.make("owner"),
				email: "owner@example.com",
				activeOrganizationId: deletedOrgId,
				iconUrlOrKey: Option.none(),
			}),
		),
	);
}

describe("organization deletion references", () => {
	beforeEach(() => {
		mocks.updates = [];
	});

	it.each(["activeOrganizationId", "defaultOrgId"])(
		"only rewrites %s when it refers to the deleted organization",
		async (field) => {
			await deleteOrganization();

			const updates = mocks.updates.filter(({ values }) => field in values);
			expect(updates).toHaveLength(2);
			for (const { condition } of updates) {
				const query = new MySqlDialect().sqlToQuery(condition);
				expect(query.sql).toBe(
					`(\`users\`.\`id\` = ? and \`users\`.\`${field}\` = ?)`,
				);
				expect(query.params[1]).toBe(deletedOrgId);
			}
		},
	);

	it("replaces both references for the owner and other members", async () => {
		await deleteOrganization();

		for (const userId of ["owner", "member"]) {
			const updates = mocks.updates.filter(
				({ condition }) =>
					new MySqlDialect().sqlToQuery(condition).params[0] === userId,
			);
			expect(Object.assign({}, ...updates.map(({ values }) => values))).toEqual(
				{ activeOrganizationId: "remaining", defaultOrgId: "remaining" },
			);
		}
	});

	it("retains the empty fallback when no organization remains", async () => {
		await deleteOrganization(null);

		expect(
			mocks.updates.every(({ values }) =>
				Object.values(values).every((value) => value === ""),
			),
		).toBe(true);
	});
});
