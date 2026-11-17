import { randomUUID } from "node:crypto";
import * as Db from "@cap/database/schema";
import {
	CurrentUser,
	type Organisation,
	type Space,
	type User,
} from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { Cause, Effect, Exit, Option } from "effect";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deleteOrganizationMembership } from "@/lib/organization-member-removal";
import { FoldersPolicy } from "../../../../packages/web-backend/src/Folders/FoldersPolicy";
import { Spaces } from "../../../../packages/web-backend/src/Spaces";

const fixture = vi.hoisted(() => ({ database: undefined as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database")>()),
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);
const database = () => fixture.database as MySql2Database;

type Org = { orgId: Organisation.OrganisationId; ownerId: User.UserId };

const createOrganization = async (options?: { tombstoned?: boolean }) => {
	const orgId = id() as Organisation.OrganisationId;
	const ownerId = id() as User.UserId;
	await database()
		.insert(Db.organizations)
		.values({
			id: orgId,
			name: "Acme",
			ownerId,
			tombstoneAt: options?.tombstoned ? new Date() : null,
		});
	return { orgId, ownerId } satisfies Org;
};

const addOrganizationMember = async (
	org: Org,
	role: "admin" | "member",
	userId = id() as User.UserId,
) => {
	const memberId = id();
	await database().insert(Db.organizationMembers).values({
		id: memberId,
		organizationId: org.orgId,
		userId,
		role,
	});
	return { memberId, userId };
};

const createSpace = async (
	org: Org,
	createdById: User.UserId,
	members: Array<{ userId: User.UserId; role: "admin" | "member" }> = [],
) => {
	const spaceId = id() as Space.SpaceIdOrOrganisationId;
	await database().insert(Db.spaces).values({
		id: spaceId,
		name: "Launch",
		organizationId: org.orgId,
		createdById,
	});
	if (members.length > 0) {
		await database()
			.insert(Db.spaceMembers)
			.values(
				members.map((member) => ({
					id: id(),
					spaceId,
					userId: member.userId,
					role: member.role,
				})),
			);
	}
	return spaceId;
};

const asUser = <A, E>(
	userId: User.UserId,
	effect: Effect.Effect<A, E, CurrentUser | Spaces | FoldersPolicy>,
) =>
	effect.pipe(
		Effect.provide(Spaces.Default),
		Effect.provide(FoldersPolicy.Default),
		Effect.provideService(CurrentUser, {
			id: userId,
			email: `${userId}@example.com`,
			activeOrganizationId: id() as Organisation.OrganisationId,
			iconUrlOrKey: Option.none(),
		}),
		Effect.runPromiseExit,
	);

const openSpace = (
	userId: User.UserId,
	spaceId: Space.SpaceIdOrOrganisationId,
) =>
	asUser(
		userId,
		Effect.flatMap(Spaces, (spaces) => spaces.getSpaceOrOrg(spaceId)),
	);

const createFolderIn = (
	userId: User.UserId,
	spaceId: Space.SpaceIdOrOrganisationId,
) =>
	asUser(
		userId,
		Effect.flatMap(FoldersPolicy, (policy) => policy.canCreateIn(spaceId)),
	);

const opened = (exit: Exit.Exit<unknown, unknown>, spaceId: string) =>
	Exit.isSuccess(exit) &&
	(exit.value as { variant: string; space?: { id: string } }).variant ===
		"space" &&
	(exit.value as { space: { id: string } }).space.id === spaceId;

const denied = (exit: Exit.Exit<unknown, unknown>) =>
	Exit.isFailure(exit) &&
	Option.exists(
		Cause.failureOption(exit.cause),
		(error) => (error as { _tag?: string })._tag === "PolicyDenied",
	);

describe.runIf(Boolean(databaseUrl))(
	"space creator access against a real database",
	() => {
		let pool: Pool;

		beforeAll(async () => {
			if (!databaseUrl) throw new Error("Missing isolated test database URL.");
			const url = new URL(databaseUrl);
			if (
				url.protocol !== "mysql:" ||
				!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
				!/^\/cap_infra_[a-z0-9_]+$/.test(url.pathname)
			)
				throw new Error("These tests require a session-scoped local database.");
			pool = createPool({ uri: databaseUrl, connectionLimit: 4 });
			fixture.database = drizzle(pool);
		});

		afterAll(async () => {
			await pool?.end();
		});

		it("keeps access for a creator who is still a member", async () => {
			const org = await createOrganization();
			const creator = await addOrganizationMember(org, "member");
			const spaceId = await createSpace(org, creator.userId);

			expect(opened(await openSpace(creator.userId, spaceId), spaceId)).toBe(
				true,
			);
			expect(
				Exit.isSuccess(await createFolderIn(creator.userId, spaceId)),
			).toBe(true);
		});

		it("revokes access once the creator is removed from the organization", async () => {
			const org = await createOrganization();
			const creator = await addOrganizationMember(org, "member");
			const spaceId = await createSpace(org, creator.userId, [
				{ userId: creator.userId, role: "admin" },
			]);

			expect(opened(await openSpace(creator.userId, spaceId), spaceId)).toBe(
				true,
			);

			await database().transaction((tx) =>
				deleteOrganizationMembership(tx, org.orgId, {
					id: creator.memberId,
					userId: creator.userId,
					hasProSeat: false,
					email: `${creator.userId}@example.com`,
				}),
			);

			const [space] = await database()
				.select({ createdById: Db.spaces.createdById })
				.from(Db.spaces)
				.where(eq(Db.spaces.id, spaceId));
			expect(space?.createdById).toBe(creator.userId);
			expect(denied(await openSpace(creator.userId, spaceId))).toBe(true);
			expect(denied(await createFolderIn(creator.userId, spaceId))).toBe(true);
		});

		it("denies a creator with no membership row at all", async () => {
			const org = await createOrganization();
			const formerMember = id() as User.UserId;
			const spaceId = await createSpace(org, formerMember);

			expect(denied(await openSpace(formerMember, spaceId))).toBe(true);
			expect(denied(await createFolderIn(formerMember, spaceId))).toBe(true);
		});

		it("keeps access for the organization owner who created the space", async () => {
			const org = await createOrganization();
			const spaceId = await createSpace(org, org.ownerId);

			expect(opened(await openSpace(org.ownerId, spaceId), spaceId)).toBe(true);
			expect(Exit.isSuccess(await createFolderIn(org.ownerId, spaceId))).toBe(
				true,
			);
		});

		it("keeps access for organization admins and space members", async () => {
			const org = await createOrganization();
			const creator = await addOrganizationMember(org, "member");
			const admin = await addOrganizationMember(org, "admin");
			const spaceMember = await addOrganizationMember(org, "member");
			const outsider = await addOrganizationMember(org, "member");
			const spaceId = await createSpace(org, creator.userId, [
				{ userId: creator.userId, role: "admin" },
				{ userId: spaceMember.userId, role: "member" },
			]);

			expect(opened(await openSpace(admin.userId, spaceId), spaceId)).toBe(
				true,
			);
			expect(Exit.isSuccess(await createFolderIn(admin.userId, spaceId))).toBe(
				true,
			);
			expect(
				opened(await openSpace(spaceMember.userId, spaceId), spaceId),
			).toBe(true);
			expect(denied(await createFolderIn(spaceMember.userId, spaceId))).toBe(
				true,
			);
			expect(denied(await openSpace(outsider.userId, spaceId))).toBe(true);
		});

		it("does not grant creator access inside a deleted organization", async () => {
			const org = await createOrganization({ tombstoned: true });
			const creator = await addOrganizationMember(org, "member");
			const spaceId = await createSpace(org, creator.userId);

			expect(denied(await openSpace(creator.userId, spaceId))).toBe(true);
		});
	},
);
