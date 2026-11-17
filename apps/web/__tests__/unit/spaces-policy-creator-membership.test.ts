import {
	CurrentUser,
	Organisation,
	Policy,
	Space,
	User,
} from "@cap/web-domain";
import { drizzle } from "drizzle-orm/mysql-proxy";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	Database as BackendDatabase,
	type DbClient,
} from "../../../../packages/web-backend/src/Database";
import { SpacesPolicy } from "../../../../packages/web-backend/src/Spaces/SpacesPolicy";
import { SpacesRepo } from "../../../../packages/web-backend/src/Spaces/SpacesRepo";

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({
	db: () => {
		throw new Error("Use the injected test database.");
	},
}));

const SPACE_ID = Space.SpaceId.make("space-1") as Space.SpaceIdOrOrganisationId;
const USER_ID = User.UserId.make("user-1");

type Fixture = {
	creatorWithOrganizationAccess: boolean;
	spaceRole: "admin" | "member" | null;
};

const calls: Array<{ userId: string; spaceId: string }> = [];

const fakeRepo = (fixture: Fixture) =>
	SpacesRepo.make({
		creatorWithOrganizationAccess: (userId: string, spaceId: string) => {
			calls.push({ userId, spaceId });
			return Effect.succeed(
				fixture.creatorWithOrganizationAccess
					? Option.some({ id: spaceId })
					: Option.none(),
			);
		},
		membership: () =>
			Effect.succeed(
				fixture.spaceRole
					? Option.some({ membershipId: "m-1", role: fixture.spaceRole })
					: Option.none(),
			),
	} as unknown as Parameters<typeof SpacesRepo.make>[0]);

const run = (
	fixture: Fixture,
	check: (policy: SpacesPolicy) => Effect.Effect<void, unknown, CurrentUser>,
) =>
	Effect.flatMap(SpacesPolicy, check).pipe(
		Effect.provide(SpacesPolicy.DefaultWithoutDependencies),
		Effect.provide(Layer.succeed(SpacesRepo, fakeRepo(fixture))),
		Effect.provideService(CurrentUser, {
			id: USER_ID,
			email: "user@example.com",
			activeOrganizationId: Organisation.OrganisationId.make("org-1"),
			iconUrlOrKey: Option.none(),
		}),
		Effect.runPromiseExit,
	);

const denied = (exit: Exit.Exit<void, unknown>) =>
	Exit.isFailure(exit) &&
	Option.exists(
		Cause.failureOption(exit.cause),
		(error) => error instanceof Policy.PolicyDeniedError,
	);

describe("SpacesPolicy creator access", () => {
	beforeEach(() => {
		calls.length = 0;
	});

	it("denies a creator who no longer belongs to the organization", async () => {
		const fixture: Fixture = {
			creatorWithOrganizationAccess: false,
			spaceRole: null,
		};

		expect(denied(await run(fixture, (p) => p.isOwner(SPACE_ID)))).toBe(true);
		expect(denied(await run(fixture, (p) => p.isMember(SPACE_ID)))).toBe(true);
		expect(denied(await run(fixture, (p) => p.isAdmin(SPACE_ID)))).toBe(true);
		expect(calls).toContainEqual({ userId: USER_ID, spaceId: SPACE_ID });
	});

	it("keeps owner, member and admin access for a creator still in the organization", async () => {
		const fixture: Fixture = {
			creatorWithOrganizationAccess: true,
			spaceRole: null,
		};

		expect(Exit.isSuccess(await run(fixture, (p) => p.isOwner(SPACE_ID)))).toBe(
			true,
		);
		expect(
			Exit.isSuccess(await run(fixture, (p) => p.isMember(SPACE_ID))),
		).toBe(true);
		expect(Exit.isSuccess(await run(fixture, (p) => p.isAdmin(SPACE_ID)))).toBe(
			true,
		);
	});

	it("keeps space membership access unchanged for non-creators", async () => {
		const member: Fixture = {
			creatorWithOrganizationAccess: false,
			spaceRole: "member",
		};
		const admin: Fixture = {
			creatorWithOrganizationAccess: false,
			spaceRole: "admin",
		};

		expect(Exit.isSuccess(await run(member, (p) => p.isMember(SPACE_ID)))).toBe(
			true,
		);
		expect(denied(await run(member, (p) => p.isAdmin(SPACE_ID)))).toBe(true);
		expect(Exit.isSuccess(await run(admin, (p) => p.isAdmin(SPACE_ID)))).toBe(
			true,
		);
	});
});

describe("SpacesRepo.creatorWithOrganizationAccess", () => {
	it("matches only the creator of a live organization they still belong to", async () => {
		const statements: Array<{ sql: string; params: unknown[] }> = [];
		const client = drizzle(async (sql, params) => {
			statements.push({ sql, params });
			return { rows: [] };
		}) as unknown as DbClient;

		const result = await Effect.flatMap(SpacesRepo, (repo) =>
			repo.creatorWithOrganizationAccess(USER_ID, SPACE_ID),
		).pipe(
			Effect.provide(SpacesRepo.DefaultWithoutDependencies),
			Effect.provideService(
				BackendDatabase,
				BackendDatabase.make({
					use: (callback) => Effect.promise(() => callback(client)),
				}),
			),
			Effect.runPromise,
		);

		expect(Option.isNone(result)).toBe(true);
		expect(statements).toHaveLength(1);
		const sql = statements[0]?.sql ?? "";
		const params = statements[0]?.params;
		expect(sql).toContain("inner join `organizations`");
		expect(sql).toContain(
			"left join `organization_members` on (`organization_members`.`organizationId` = `spaces`.`organizationId` and `organization_members`.`userId` = ?)",
		);
		expect(sql).toContain("`spaces`.`createdById` = ?");
		expect(sql).toContain("`organizations`.`tombstoneAt` is null");
		expect(sql).toContain(
			"(`organizations`.`ownerId` = ? or `organization_members`.`id` is not null)",
		);
		expect(params).toEqual([USER_ID, SPACE_ID, USER_ID, USER_ID, 1]);
	});
});
