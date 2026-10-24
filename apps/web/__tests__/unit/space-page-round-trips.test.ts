import { Database, ImageUploads } from "@cap/web-backend";
import {
	CurrentUser,
	Folder,
	Organisation,
	Space,
	User,
} from "@cap/web-domain";
import { drizzle } from "drizzle-orm/mysql-proxy";
import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SharedCapsPage from "@/app/(org)/dashboard/spaces/[spaceId]/page";
import { getVideosByFolderId } from "@/lib/folder";
import {
	Database as BackendDatabase,
	type DbClient,
} from "../../../../packages/web-backend/src/Database";
import { OrganisationsPolicy } from "../../../../packages/web-backend/src/Organisations/OrganisationsPolicy";
import { Spaces } from "../../../../packages/web-backend/src/Spaces";
import { SpacesPolicy } from "../../../../packages/web-backend/src/Spaces/SpacesPolicy";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	spaceOrOrg: null as unknown,
}));

vi.mock("server-only", () => ({}));
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
		succeed: { resolveImageUrl: (value: string) => Effect.succeed(value) },
	}) {}
	class Spaces extends Effect.Service<Spaces>()("Spaces", {
		succeed: { getSpaceOrOrg: () => Effect.succeed(mocks.spaceOrOrg) },
	}) {}
	return {
		Database,
		ImageUploads,
		Spaces,
		makeCurrentUserLayer: () => Layer.empty,
		resolveEffectiveVideoRules,
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
vi.mock("@/app/(org)/dashboard/spaces/[spaceId]/SharedCaps", () => ({
	SharedCaps: () => null,
}));

const PAGE_SIZE = 15;
const LIST_COLUMNS = {
	space: [
		"owner-1",
		"Walkthrough",
		"2026-10-23 12:00:00",
		null,
		false,
		60,
		true,
		null,
		false,
		0,
		0,
		"Owner",
		"2026-10-23 12:00:00",
		false,
	],
	folder: [
		"owner-1",
		"Walkthrough",
		"2026-10-23 12:00:00",
		true,
		null,
		{ type: "webMP4" },
		false,
		60,
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
};

function listRows(columns: unknown[]) {
	return Array.from({ length: PAGE_SIZE }, (_, index) => [
		`video-${index}`,
		...columns,
	]);
}

// Holds every query until the page has issued all the queries it can without
// an answer, then answers them together. Each release is one database round
// trip on the page's critical path.
async function countRoundTrips(
	load: () => Promise<unknown>,
	columns: unknown[],
) {
	const pending: Array<() => void> = [];
	mocks.query.mockImplementation(
		(sql: string) =>
			new Promise((resolve) =>
				pending.push(() =>
					resolve({
						rows: sql.includes(" group by ") ? listRows(columns) : [],
					}),
				),
			),
	);

	let settled = false;
	const result = load().finally(() => {
		settled = true;
	});
	let roundTrips = 0;
	let idleTicks = 0;
	while (!settled) {
		const issued = mocks.query.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (mocks.query.mock.calls.length !== issued || pending.length === 0) {
			idleTicks = 0;
			continue;
		}
		if (++idleTicks < 3) continue;
		idleTicks = 0;
		roundTrips++;
		for (const release of pending.splice(0)) release();
	}
	await result;
	return { roundTrips, queries: mocks.query.mock.calls.length };
}

beforeEach(() => {
	mocks.query.mockReset();
});

describe("space and folder page round trips", () => {
	it("loads a space page in two round trips", async () => {
		mocks.spaceOrOrg = {
			variant: "space",
			space: { id: "space-1", organizationId: "org-1", iconUrl: null },
		};
		const result = await countRoundTrips(
			() =>
				SharedCapsPage({
					params: Promise.resolve({ spaceId: "space-1" }),
					searchParams: Promise.resolve({}),
				}),
			LIST_COLUMNS.space,
		);
		expect(result).toEqual({ roundTrips: 2, queries: 8 });
	});

	it("loads an organization page in two round trips", async () => {
		mocks.spaceOrOrg = {
			variant: "organization",
			organization: { id: "org-1", name: "Org", ownerId: "owner-1" },
		};
		const result = await countRoundTrips(
			() =>
				SharedCapsPage({
					params: Promise.resolve({ spaceId: "org-1" }),
					searchParams: Promise.resolve({}),
				}),
			LIST_COLUMNS.space,
		);
		expect(result).toEqual({ roundTrips: 2, queries: 7 });
	});

	it("looks up the space and the organization together", async () => {
		const client = drizzle(mocks.query) as unknown as DbClient;
		const result = await countRoundTrips(
			() =>
				Effect.flatMap(Spaces, (spaces) =>
					spaces.getSpaceOrOrg(Space.SpaceId.make("space-1")),
				).pipe(
					Effect.provide(Spaces.DefaultWithoutDependencies),
					Effect.provideService(
						BackendDatabase,
						BackendDatabase.make({
							use: (callback) => Effect.promise(() => callback(client)),
						}),
					),
					Effect.provideService(
						SpacesPolicy,
						SpacesPolicy.make({
							isMember: () => Effect.void,
							isOwner: () => Effect.void,
							isAdmin: () => Effect.void,
						}),
					),
					Effect.provideService(
						OrganisationsPolicy,
						OrganisationsPolicy.make({
							isMember: () => Effect.void,
							isOwner: () => Effect.void,
							isAdminOrOwner: () => Effect.void,
						}),
					),
					Effect.provideService(CurrentUser, {
						id: User.UserId.make("user-1"),
						email: "user@example.com",
						activeOrganizationId: Organisation.OrganisationId.make("org-1"),
						iconUrlOrKey: Option.none(),
					}),
					Effect.runPromise,
				),
			[],
		);

		expect(result).toEqual({ roundTrips: 1, queries: 2 });
	});

	it("loads folder videos in two round trips", async () => {
		const result = await countRoundTrips(
			() =>
				getVideosByFolderId(Folder.FolderId.make("folder-1"), {
					variant: "user",
				}).pipe(
					Effect.provide(Database.Default),
					Effect.provide(ImageUploads.Default),
					Effect.runPromise,
				),
			LIST_COLUMNS.folder,
		);
		expect(result).toEqual({ roundTrips: 2, queries: 4 });
	});
});
