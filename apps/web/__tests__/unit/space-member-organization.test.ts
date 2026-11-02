import { Space, User } from "@cap/web-domain";
import { getTableName } from "drizzle-orm";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: vi.fn(),
	spaceAccess: vi.fn(),
	spaceManager: vi.fn(),
	organizationAccess: vi.fn(),
	organizationMemberIds: [] as string[],
	spaces: [] as unknown[],
	writes: [] as string[],
	inserted: [] as { userId: string; role: string }[],
}));

function rowsFor(table: string) {
	if (table === "organization_members") {
		return mocks.organizationMemberIds.map((userId) => ({ userId }));
	}
	if (table === "spaces") return mocks.spaces;
	return [];
}

type SelectQuery = Promise<unknown[]> & {
	where(): SelectQuery;
	limit(): SelectQuery;
};

function selectQuery() {
	return {
		from(value: MySqlTable) {
			const query: SelectQuery = Object.assign(
				Promise.resolve(rowsFor(getTableName(value))),
				{ where: () => query, limit: () => query },
			);
			return query;
		},
	};
}

function write(kind: string) {
	return (value: MySqlTable) => {
		const table = getTableName(value);
		const done = { where: async () => mocks.writes.push(`${kind}:${table}`) };
		return {
			...done,
			set: () => done,
			values: async (rows: { userId: string; role: string }[]) => {
				if (rows.length === 0)
					throw new Error("values() needs at least one row");
				mocks.writes.push(`${kind}:${table}`);
				if (table === "space_members") mocks.inserted.push(...rows);
			},
		};
	};
}

const database = {
	select: selectQuery,
	insert: write("insert"),
	update: write("update"),
	delete: write("delete"),
	transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(database),
};

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({ db: () => database }));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@cap/database/crypto", () => ({ hashPassword: vi.fn() }));
vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("@cap/web-backend", () => ({ S3Buckets: {} }));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/org-pro", () => ({ isOrganizationOwnerPro: async () => true }));
vi.mock("@/actions/organization/space-authorization", () => ({
	getSpaceAccess: mocks.spaceAccess,
	requireSpaceManager: mocks.spaceManager,
}));
vi.mock("@/actions/organization/authorization", () => ({
	getOrganizationAccess: mocks.organizationAccess,
}));
vi.mock("@/actions/organization/upload-space-icon", () => ({
	uploadSpaceIcon: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createSpace } from "@/actions/organization/create-space";
import { updateSpace } from "@/actions/organization/update-space";
import { setSpaceMembers } from "@/app/(org)/dashboard/spaces/[spaceId]/actions";

function spaceForm(members: string[]) {
	const formData = new FormData();
	formData.append("id", "space-1");
	formData.append("name", "Design");
	for (const member of members) formData.append("members[]", member);
	return formData;
}

beforeEach(() => {
	mocks.writes.length = 0;
	mocks.inserted.length = 0;
	mocks.organizationMemberIds = ["creator", "member"];
	mocks.spaces = [];
	mocks.user.mockResolvedValue({
		id: "creator",
		activeOrganizationId: "org-1",
	});
	mocks.spaceAccess.mockResolvedValue({
		organizationId: "org-1",
		organizationOwnerId: "owner",
		canManage: true,
	});
	mocks.organizationAccess.mockResolvedValue({ ownerId: "owner" });
	mocks.spaceManager.mockResolvedValue({
		organizationId: "org-1",
		organizationOwnerId: "owner",
		createdById: "creator",
	});
});

describe("editing a space", () => {
	beforeEach(() => {
		mocks.spaces = [
			{
				createdById: "creator",
				organizationId: "org-1",
				settings: null,
				public: false,
			},
		];
	});

	it("rejects an outsider before changing anything", async () => {
		await expect(
			updateSpace(spaceForm(["member", "outsider"])),
		).resolves.toEqual({
			success: false,
			error: "All space members must belong to the organization",
		});
		expect(mocks.writes).toEqual([]);
	});

	it("keeps organization members and the owner", async () => {
		await expect(updateSpace(spaceForm(["member", "owner"]))).resolves.toEqual({
			success: true,
		});
		expect(mocks.inserted.map((row) => row.userId).sort()).toEqual([
			"creator",
			"member",
			"owner",
		]);
	});

	it("does not restore a creator who left the organization", async () => {
		mocks.organizationMemberIds = ["member"];
		await expect(updateSpace(spaceForm(["member"]))).resolves.toEqual({
			success: true,
		});
		expect(mocks.inserted).toEqual([
			expect.objectContaining({ userId: "member", role: "member" }),
		]);
	});

	it("saves with no members once the creator has left", async () => {
		mocks.organizationMemberIds = ["member"];
		await expect(updateSpace(spaceForm([]))).resolves.toEqual({
			success: true,
		});
		expect(mocks.writes).toContain("delete:space_members");
		expect(mocks.inserted).toEqual([]);
	});
});

describe("creating a space", () => {
	it("rejects an outsider", async () => {
		await expect(
			createSpace(spaceForm(["member", "outsider"])),
		).resolves.toEqual({
			success: false,
			error: "All space members must belong to the organization",
		});
		expect(mocks.writes).toEqual([]);
	});

	it("rejects a creator who left the organization", async () => {
		mocks.organizationAccess.mockResolvedValue(null);
		await expect(createSpace(spaceForm([]))).resolves.toEqual({
			success: false,
			error: "Unauthorized",
		});
		expect(mocks.writes).toEqual([]);
	});

	it("adds organization members", async () => {
		await expect(createSpace(spaceForm(["member"]))).resolves.toMatchObject({
			success: true,
		});
		expect(mocks.inserted).toEqual([
			expect.objectContaining({ userId: "member", role: "member" }),
			expect.objectContaining({ userId: "creator", role: "admin" }),
		]);
	});
});

describe("setting space members", () => {
	const setMembers = (userIds: string[]) =>
		setSpaceMembers({
			spaceId: Space.SpaceId.make("space-1"),
			userIds: userIds.map((userId) => User.UserId.make(userId)),
			role: "member",
		});

	it("keeps the creator as admin", async () => {
		await setMembers(["member"]);
		expect(mocks.inserted).toEqual([
			expect.objectContaining({ userId: "member", role: "member" }),
			expect.objectContaining({ userId: "creator", role: "admin" }),
		]);
	});

	it("does not restore a creator who left the organization", async () => {
		mocks.organizationMemberIds = ["member"];
		await setMembers(["member"]);
		expect(mocks.inserted).toEqual([
			expect.objectContaining({ userId: "member", role: "member" }),
		]);
	});

	it("saves with no members once the creator has left", async () => {
		mocks.organizationMemberIds = ["member"];
		await expect(setMembers([])).resolves.toEqual({ success: true, count: 0 });
		expect(mocks.writes).toContain("delete:space_members");
		expect(mocks.inserted).toEqual([]);
	});
});
