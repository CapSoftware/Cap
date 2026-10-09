import { Space } from "@cap/web-domain";
import { getTableName } from "drizzle-orm";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: vi.fn(),
	manager: vi.fn(),
	runPromise: vi.fn(),
	transaction: vi.fn(),
	events: [] as string[],
}));

function table(value: MySqlTable) {
	return getTableName(value);
}

function selectQuery(prefix: string, rows: () => unknown[]) {
	return () => {
		const query = Object.assign(Promise.resolve(rows()), {
			from(value: MySqlTable) {
				mocks.events.push(`${prefix}select:${table(value)}`);
				return query;
			},
			where() {
				return query;
			},
			limit() {
				return query;
			},
			for(lock: string) {
				mocks.events.push(`${prefix}lock:${lock}`);
				return query;
			},
		});
		return query;
	};
}

function deleteQuery(prefix: string) {
	return (value: MySqlTable) => ({
		where: async () => {
			mocks.events.push(`${prefix}delete:${table(value)}`);
		},
	});
}

vi.mock("@cap/database", () => ({
	db: () => ({
		select: selectQuery("", () => [{ id: "space-1" }]),
		delete: deleteQuery(""),
		transaction: mocks.transaction,
	}),
}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/actions/organization/space-authorization", () => ({
	requireSpaceManager: mocks.manager,
}));
vi.mock("@cap/web-backend", () => ({ S3Buckets: {} }));
vi.mock("@/lib/server", () => ({ runPromise: mocks.runPromise }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { deleteSpace } from "@/actions/organization/delete-space";

const spaceId = Space.SpaceId.make("space-1");

beforeEach(() => {
	mocks.events.length = 0;
	mocks.user.mockResolvedValue({ id: "user-1", activeOrganizationId: "org" });
	mocks.manager.mockResolvedValue({ canManage: true });
	mocks.runPromise.mockImplementation(async () => {
		mocks.events.push("s3");
	});
	mocks.transaction.mockImplementation(
		async (callback: (tx: unknown) => Promise<unknown>) => {
			mocks.events.push("begin");
			await callback({
				select: selectQuery("tx:", () => [{ id: spaceId }]),
				delete: deleteQuery("tx:"),
			});
			mocks.events.push("commit");
		},
	);
});

describe("deleting a space", () => {
	it("locks the space and removes its records in one transaction before storage cleanup", async () => {
		await expect(deleteSpace(spaceId)).resolves.toEqual({ success: true });
		expect(mocks.events).toEqual([
			"select:spaces",
			"begin",
			"tx:select:spaces",
			"tx:lock:update",
			"tx:delete:space_videos",
			"tx:delete:space_members",
			"tx:delete:folders",
			"tx:delete:spaces",
			"commit",
			"s3",
		]);
	});

	it("does not touch records when the caller cannot manage the space", async () => {
		mocks.manager.mockRejectedValue(new Error("Forbidden"));
		await expect(deleteSpace(spaceId)).resolves.toMatchObject({
			success: false,
		});
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.events).toEqual(["select:spaces"]);
	});
});
