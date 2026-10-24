import type { Database, ImageUploads, Spaces } from "@cap/web-backend";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CapsPage from "@/app/(org)/dashboard/caps/page";
import SharedCapsPage from "@/app/(org)/dashboard/spaces/[spaceId]/page";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "user-1", activeOrganizationId: "org-1" }),
}));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/web-backend", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const { Effect, Layer } = await import("effect");
	const client = drizzle(mocks.query);
	class Database extends Effect.Service<Database>()("Database", {
		succeed: {
			use: <T>(callback: (db: typeof client) => Promise<T>) =>
				Effect.promise(() => callback(client)),
		},
	}) {}
	class ImageUploads extends Effect.Service<ImageUploads>()("ImageUploads", {
		succeed: { resolveImageUrl: (value: string) => Effect.succeed(value) },
	}) {}
	class Spaces extends Effect.Service<Spaces>()("Spaces", {
		succeed: {
			getSpaceOrOrg: () =>
				Effect.succeed({
					variant: "organization",
					organization: { id: "org-1" },
				}),
		},
	}) {}
	return {
		Database,
		ImageUploads,
		Spaces,
		makeCurrentUserLayer: () => Layer.empty,
	};
});
vi.mock("@/lib/server", async () => {
	const { Database, ImageUploads, Spaces } = await import("@cap/web-backend");
	return {
		runPromise: <A, E>(
			effect: Effect.Effect<A, E, Database | ImageUploads | Spaces>,
		) =>
			Effect.runPromise(
				Effect.provide(
					effect,
					Layer.mergeAll(
						Database.Default,
						ImageUploads.Default,
						Spaces.Default,
					),
				),
			),
	};
});
vi.mock("@/app/(org)/dashboard/caps/Caps", () => ({ Caps: () => null }));
vi.mock("@/app/(org)/dashboard/spaces/[spaceId]/SharedCaps", () => ({
	SharedCaps: () => null,
}));

beforeEach(() => {
	mocks.query.mockResolvedValue({ rows: [] });
});

describe("dashboard pagination counts", () => {
	it.each([
		{
			name: "personal Caps",
			folderTable: "videos",
			load: () =>
				CapsPage({
					params: Promise.resolve({}),
					searchParams: Promise.resolve({}),
				}),
		},
		{
			name: "organization Caps",
			folderTable: "shared_videos",
			load: () =>
				SharedCapsPage({
					params: Promise.resolve({ spaceId: "org-1" }),
					searchParams: Promise.resolve({}),
				}),
		},
	])(
		"counts the same root videos it lists for $name",
		async ({ load, folderTable }) => {
			await load();
			const queries = mocks.query.mock.calls.map(([query]) => String(query));
			const countQuery = queries.find((query) =>
				query.startsWith("select count(*)"),
			);
			const listQuery = queries.find((query) => query.includes(" group by "));
			const folderFilter = `\`${folderTable}\`.\`folderId\` is null`;

			expect(listQuery).toContain(folderFilter);
			expect(countQuery).toContain(folderFilter);
			if (folderTable === "shared_videos") {
				expect(countQuery).not.toContain("`videos`.`folderId`");
			}
		},
	);
});
