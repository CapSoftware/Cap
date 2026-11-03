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
	events: [] as string[],
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
	for(strength: string): SelectQuery;
};

type MemberRow = { userId: string; role: string };

function selectQuery(prefix: string) {
	return () => ({
		from(value: MySqlTable) {
			const table = getTableName(value);
			if (table === "organization_members") {
				mocks.events.push(`${prefix}select:${table}`);
			}
			const query: SelectQuery = Object.assign(
				Promise.resolve(rowsFor(table)),
				{
					where: () => query,
					limit: () => query,
					for: (strength: string) => {
						mocks.events.push(`${prefix}lock:${strength}`);
						return query;
					},
				},
			);
			return query;
		},
	});
}

function write(prefix: string, kind: string) {
	return (value: MySqlTable) => {
		const table = getTableName(value);
		const event = `${prefix}${kind}:${table}`;
		const done = { where: async () => mocks.events.push(event) };
		return {
			...done,
			set: () => done,
			values: async (rows: MemberRow | MemberRow[]) => {
				const list = Array.isArray(rows) ? rows : [rows];
				if (list.length === 0) {
					throw new Error("values() needs at least one row");
				}
				mocks.events.push(event);
				if (table === "space_members") mocks.inserted.push(...list);
			},
		};
	};
}

function client(prefix: string) {
	return {
		select: selectQuery(prefix),
		insert: write(prefix, "insert"),
		update: write(prefix, "update"),
		delete: write(prefix, "delete"),
	};
}

const transaction = client("tx:");
const database = {
	...client(""),
	transaction: async (fn: (tx: typeof transaction) => Promise<unknown>) => {
		mocks.events.push("begin");
		try {
			const result = await fn(transaction);
			mocks.events.push("commit");
			return result;
		} catch (error) {
			mocks.events.push("rollback");
			throw error;
		}
	},
};

const lockedMembershipCheck = [
	"tx:select:organization_members",
	"tx:lock:share",
];

function writes() {
	return mocks.events.filter((event) => /(insert|update|delete):/.test(event));
}

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
import {
	addSpaceMember,
	addSpaceMembers,
	setSpaceMembers,
} from "@/app/(org)/dashboard/spaces/[spaceId]/actions";

function spaceForm(members: string[]) {
	const formData = new FormData();
	formData.append("id", "space-1");
	formData.append("name", "Design");
	for (const member of members) formData.append("members[]", member);
	return formData;
}

beforeEach(() => {
	mocks.events.length = 0;
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
		expect(writes()).toEqual([]);
	});

	it("checks members under a lock in the transaction that writes them", async () => {
		await expect(updateSpace(spaceForm(["member"]))).resolves.toEqual({
			success: true,
		});
		expect(mocks.events).toEqual([
			"begin",
			...lockedMembershipCheck,
			...lockedMembershipCheck,
			"tx:update:spaces",
			"tx:delete:space_members",
			"tx:insert:space_members",
			"commit",
		]);
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
		expect(writes()).toEqual(["tx:update:spaces", "tx:delete:space_members"]);
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
		expect(writes()).toEqual([]);
	});

	it("rejects a creator who left the organization", async () => {
		mocks.organizationAccess.mockResolvedValue(null);
		await expect(createSpace(spaceForm([]))).resolves.toEqual({
			success: false,
			error: "Unauthorized",
		});
		expect(writes()).toEqual([]);
	});

	it("checks members under a lock in the transaction that writes them", async () => {
		await expect(createSpace(spaceForm(["member"]))).resolves.toMatchObject({
			success: true,
		});
		expect(mocks.events).toEqual([
			"begin",
			...lockedMembershipCheck,
			"tx:insert:spaces",
			"tx:insert:space_members",
			"commit",
		]);
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

	it("checks members under a lock in the transaction that writes them", async () => {
		await setMembers(["member"]);
		expect(mocks.events).toEqual([
			"begin",
			...lockedMembershipCheck,
			...lockedMembershipCheck,
			"tx:delete:space_members",
			"tx:insert:space_members",
			"commit",
		]);
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
		expect(writes()).toEqual(["tx:delete:space_members"]);
		expect(mocks.inserted).toEqual([]);
	});
});

describe("adding space members", () => {
	const spaceId = Space.SpaceId.make("space-1");

	it("checks one member under a lock in the transaction that adds them", async () => {
		await addSpaceMember({
			spaceId,
			userId: User.UserId.make("member"),
			role: "member",
		});
		expect(mocks.events).toEqual([
			"begin",
			...lockedMembershipCheck,
			"tx:insert:space_members",
			"commit",
		]);
	});

	it("checks several members under a lock in the transaction that adds them", async () => {
		await addSpaceMembers({
			spaceId,
			userIds: [User.UserId.make("member")],
			role: "member",
		});
		expect(mocks.events).toEqual([
			"begin",
			...lockedMembershipCheck,
			"tx:insert:space_members",
			"commit",
		]);
	});

	it("rolls back without writing when a member left the organization", async () => {
		await expect(
			addSpaceMember({
				spaceId,
				userId: User.UserId.make("outsider"),
				role: "member",
			}),
		).rejects.toThrow("All space members must belong to the organization");
		expect(mocks.events).toEqual([
			"begin",
			...lockedMembershipCheck,
			"rollback",
		]);
	});
});
