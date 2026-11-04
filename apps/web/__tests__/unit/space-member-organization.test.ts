import { Space, User } from "@cap/web-domain";
import { getTableName, type SQL } from "drizzle-orm";
import { MySqlDialect, type MySqlTable } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: vi.fn(),
	spaceAccess: vi.fn(),
	select: vi.fn(),
	insert: vi.fn(),
	update: vi.fn(),
	delete: vi.fn(),
	transaction: vi.fn(),
}));
vi.mock("@cap/database", () => ({ db: () => mocks }));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@cap/database/crypto", () => ({
	hashPassword: async (value: string) => `hashed:${value}`,
}));
vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("@cap/web-backend", () => ({ S3Buckets: {} }));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/org-pro", () => ({ isOrganizationOwnerPro: async () => true }));
vi.mock("@/actions/organization/upload-space-icon", () => ({
	uploadSpaceIcon: vi.fn(),
}));
vi.mock("@/actions/organization/space-authorization", () => ({
	getSpaceAccess: mocks.spaceAccess,
	requireSpaceManager: mocks.spaceAccess,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createSpace } from "@/actions/organization/create-space";
import { updateSpace } from "@/actions/organization/update-space";
import { addSpaceMembers } from "@/app/(org)/dashboard/spaces/[spaceId]/actions";

const dialect = new MySqlDialect();
const organizationUserIds = new Set(["creator", "teammate", "org-owner"]);
let existingSpaceMembers: { userId: string; role: string }[];
const insertedMembers: { userId: string; role: string }[] = [];

function memberForm(entries: Record<string, string | string[]>) {
	const formData = new FormData();
	for (const [key, value] of Object.entries(entries)) {
		for (const item of Array.isArray(value) ? value : [value]) {
			formData.append(key, item);
		}
	}
	return formData;
}

function insertedUserRoles() {
	return insertedMembers
		.map(({ userId, role }) => ({ userId, role }))
		.sort((a, b) => a.userId.localeCompare(b.userId));
}

beforeEach(() => {
	insertedMembers.length = 0;
	existingSpaceMembers = [];
	mocks.user.mockResolvedValue({
		id: "creator",
		activeOrganizationId: "org-1",
	});
	mocks.spaceAccess.mockResolvedValue({
		spaceId: "space-1",
		organizationId: "org-1",
		organizationOwnerId: "org-owner",
		createdById: "creator",
		canManage: true,
	});
	mocks.select.mockImplementation(() => {
		let table = "";
		let params: unknown[] = [];
		const rows = () => {
			if (table === "organization_members")
				return params
					.filter((id) => typeof id === "string" && organizationUserIds.has(id))
					.map((userId) => ({ userId }));
			if (table === "organizations")
				return [{ id: "org-1", ownerId: "org-owner" }];
			if (table === "spaces") {
				if (params.includes("space-1"))
					return [
						{
							createdById: "creator",
							organizationId: "org-1",
							settings: null,
							public: false,
						},
					];
				return [];
			}
			if (table === "space_members") return existingSpaceMembers;
			return [];
		};
		const query = Object.assign(
			Promise.resolve().then(() => rows()),
			{
				from(value: MySqlTable) {
					table = getTableName(value);
					return query;
				},
				where(filter: SQL) {
					params = dialect.sqlToQuery(filter).params;
					return query;
				},
				limit: () => query,
			},
		);
		return query;
	});
	mocks.insert.mockImplementation((table: MySqlTable) => ({
		values: async (values: unknown) => {
			if (getTableName(table) !== "space_members") return;
			const list = Array.isArray(values) ? values : [values];
			insertedMembers.push(...(list as { userId: string; role: string }[]));
		},
	}));
	mocks.update.mockImplementation(() => ({
		set: () => ({ where: async () => undefined }),
	}));
	mocks.delete.mockImplementation(() => ({ where: async () => undefined }));
	mocks.transaction.mockImplementation(
		async (callback: (tx: typeof mocks) => Promise<unknown>) => callback(mocks),
	);
});

describe("creating a space with members", () => {
	it("adds only organization members and keeps the creator as admin", async () => {
		const result = await createSpace(
			memberForm({
				name: "Sales",
				"members[]": ["teammate", "outsider-user-1"],
			}),
		);

		expect(result).toMatchObject({ success: true });
		expect(insertedUserRoles()).toEqual([
			{ userId: "creator", role: "admin" },
			{ userId: "teammate", role: "member" },
		]);
	});

	it("still creates the space when a member id is malformed", async () => {
		const result = await createSpace(
			memberForm({
				name: "Sales",
				"members[]": ["teammate", "x".repeat(64)],
			}),
		);

		expect(result).toMatchObject({ success: true });
		expect(insertedUserRoles()).toEqual([
			{ userId: "creator", role: "admin" },
			{ userId: "teammate", role: "member" },
		]);
	});

	it("adds the creator as admin when no members are submitted", async () => {
		const result = await createSpace(memberForm({ name: "Sales" }));

		expect(result).toMatchObject({ success: true });
		expect(insertedUserRoles()).toEqual([{ userId: "creator", role: "admin" }]);
	});

	it("adds the organization owner when they are selected", async () => {
		const result = await createSpace(
			memberForm({ name: "Sales", "members[]": ["org-owner"] }),
		);

		expect(result).toMatchObject({ success: true });
		expect(insertedUserRoles()).toEqual([
			{ userId: "creator", role: "admin" },
			{ userId: "org-owner", role: "member" },
		]);
	});
});

describe("updating a space's members", () => {
	it("keeps only organization members, the creator and existing roles", async () => {
		existingSpaceMembers = [
			{ userId: "creator", role: "admin" },
			{ userId: "teammate", role: "admin" },
		];

		const result = await updateSpace(
			memberForm({
				id: "space-1",
				name: "Sales",
				passwordAction: "keep",
				"members[]": ["teammate", "outsider-user-1"],
			}),
		);

		expect(result).toEqual({ success: true });
		expect(insertedUserRoles()).toEqual([
			{ userId: "creator", role: "admin" },
			{ userId: "teammate", role: "admin" },
		]);
	});

	it("adds newly selected organization members as members", async () => {
		const result = await updateSpace(
			memberForm({
				id: "space-1",
				name: "Sales",
				passwordAction: "keep",
				"members[]": ["teammate", "org-owner"],
			}),
		);

		expect(result).toEqual({ success: true });
		expect(insertedUserRoles()).toEqual([
			{ userId: "creator", role: "admin" },
			{ userId: "org-owner", role: "member" },
			{ userId: "teammate", role: "member" },
		]);
	});
});

describe("adding space members from the space page", () => {
	it("still rejects the whole request when any id is outside the organization", async () => {
		await expect(
			addSpaceMembers({
				spaceId: Space.SpaceId.make("space-1"),
				userIds: ["teammate", "outsider-user-1"].map((id) =>
					User.UserId.make(id),
				),
				role: "member",
			}),
		).rejects.toThrow("All space members must belong to the organization");
		expect(insertedMembers).toEqual([]);
	});

	it("adds organization members and the organization owner", async () => {
		await expect(
			addSpaceMembers({
				spaceId: Space.SpaceId.make("space-1"),
				userIds: ["teammate", "org-owner"].map((id) => User.UserId.make(id)),
				role: "member",
			}),
		).resolves.toMatchObject({ success: true });
		expect(insertedUserRoles()).toEqual([
			{ userId: "org-owner", role: "member" },
			{ userId: "teammate", role: "member" },
		]);
	});
});
