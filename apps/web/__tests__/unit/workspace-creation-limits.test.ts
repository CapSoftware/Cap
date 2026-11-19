import { getTableName } from "drizzle-orm";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	ownedOrganizations: 0,
	spacesInOrganization: 0,
	locks: new Map<string, Promise<void>>(),
	lockRows: true,
	events: [] as string[],
	rateLimited: new Set<string>(),
	putObject: vi.fn(),
	deleteObject: vi.fn(),
	uploadSpaceIcon: vi.fn(),
}));

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeClient(releases: (() => void)[]) {
	const acquire = async (id: string) => {
		if (!state.lockRows) return;
		const previous = state.locks.get(id) ?? Promise.resolve();
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		state.locks.set(
			id,
			previous.then(() => held),
		);
		await previous;
		releases.push(release);
	};
	const client = {
		select: (fields?: Record<string, unknown>) => {
			let table = "";
			const rows = async () => {
				await pause();
				if (fields && "total" in fields) {
					state.events.push(`count:${table}`);
					return [
						{
							total:
								table === "organizations"
									? state.ownedOrganizations
									: state.spacesInOrganization,
						},
					];
				}
				return [];
			};
			const query = {
				from(value: MySqlTable) {
					table = getTableName(value);
					return query;
				},
				where: () => query,
				limit: () => query,
				for: async () => {
					state.events.push(`lock:${table}`);
					await acquire(table);
					return [];
				},
				// biome-ignore lint/suspicious/noThenProperty: drizzle queries are thenable
				then: (
					resolve: (value: unknown) => unknown,
					reject: (error: unknown) => unknown,
				) => rows().then(resolve, reject),
			};
			return query;
		},
		insert: (value: MySqlTable) => ({
			values: async () => {
				const table = getTableName(value);
				state.events.push(`insert:${table}`);
				await pause();
				if (table === "organizations") state.ownedOrganizations++;
				if (table === "spaces") state.spacesInOrganization++;
			},
		}),
		update: () => ({ set: () => ({ where: async () => undefined }) }),
		transaction: async (run: (tx: unknown) => Promise<unknown>) => {
			const txReleases: (() => void)[] = [];
			try {
				return await run(makeClient(txReleases));
			} finally {
				for (const release of txReleases) release();
			}
		},
	};
	return client;
}

vi.mock("@cap/database", () => ({ db: () => makeClient([]) }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({
		id: "user-1",
		activeOrganizationId: "org-1",
	}),
}));
vi.mock("@cap/database/crypto", () => ({
	hashPassword: async (value: string) => `hashed:${value}`,
}));
vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	return {
		S3Buckets: {
			getBucketAccess: () =>
				Effect.succeed([
					{
						putObject: (key: string) => Effect.sync(() => state.putObject(key)),
						deleteObject: (key: string) =>
							Effect.sync(() => state.deleteObject(key)),
					},
				]),
		},
	};
});
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return { runPromise: Effect.runPromise };
});
vi.mock("@/lib/org-pro", () => ({ isOrganizationOwnerPro: async () => true }));
vi.mock("@/actions/organization/upload-space-icon", () => ({
	uploadSpaceIcon: state.uploadSpaceIcon,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
	RATE_LIMIT_IDS: {
		ORGANIZATION_CREATE: "rl_organization_create",
		SPACE_CREATE: "rl_space_create",
	},
	isRateLimited: async (ruleId: string, opts: { key: string }) =>
		state.rateLimited.has(`${ruleId}|${opts.key}`),
}));

import { createSpace } from "@/actions/organization/create-space";
import { createOrganization } from "@/components/forms/server";
import {
	ORGANIZATION_LIMIT,
	ORGANIZATION_LIMIT_MESSAGE,
	ORGANIZATION_RATE_MESSAGE,
	SPACE_LIMIT,
	SPACE_LIMIT_MESSAGE,
	SPACE_RATE_MESSAGE,
} from "@/lib/workspace-creation-limits";

function form(entries: Record<string, string | File>) {
	const data = new FormData();
	for (const [key, value] of Object.entries(entries)) data.append(key, value);
	return data;
}

const icon = () =>
	new File([new Uint8Array(16)], "icon.png", { type: "image/png" });

beforeEach(() => {
	state.ownedOrganizations = 0;
	state.spacesInOrganization = 0;
	state.locks.clear();
	state.lockRows = true;
	state.events.length = 0;
	state.rateLimited.clear();
	state.putObject.mockReset();
	state.deleteObject.mockReset();
	state.uploadSpaceIcon.mockReset();
	state.uploadSpaceIcon.mockResolvedValue({ iconUrl: "icon-key" });
});

describe("organization creation limits", () => {
	it("creates an organization with an icon for a normal user", async () => {
		state.ownedOrganizations = 1;

		const result = await createOrganization(
			form({ name: "Acme", icon: icon() }),
		);

		expect(result).toMatchObject({ success: true });
		expect(state.putObject).toHaveBeenCalledOnce();
		expect(state.events).toEqual([
			"count:organizations",
			"lock:users",
			"count:organizations",
			"insert:organizations",
			"insert:organization_members",
		]);
	});

	it("refuses a user creating organizations too quickly before any upload", async () => {
		state.rateLimited.add("rl_organization_create|organization-create:user-1");

		const result = await createOrganization(
			form({ name: "Acme", icon: icon() }),
		);

		expect(result).toEqual({
			success: false,
			error: ORGANIZATION_RATE_MESSAGE,
		});
		expect(state.putObject).not.toHaveBeenCalled();
		expect(state.events).not.toContain("insert:organizations");
	});

	it("refuses a user at the cap before any upload", async () => {
		state.ownedOrganizations = ORGANIZATION_LIMIT;

		const result = await createOrganization(
			form({ name: "Acme", icon: icon() }),
		);

		expect(result).toEqual({
			success: false,
			error: ORGANIZATION_LIMIT_MESSAGE,
		});
		expect(state.putObject).not.toHaveBeenCalled();
		expect(state.events).not.toContain("insert:organizations");
	});

	it("never passes the cap with concurrent creates", async () => {
		state.ownedOrganizations = ORGANIZATION_LIMIT - 3;

		const results = await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				createOrganization(form({ name: `Acme ${index}` })),
			),
		);

		expect(results.filter((result) => result.success)).toHaveLength(3);
		expect(state.ownedOrganizations).toBe(ORGANIZATION_LIMIT);
	});

	it("removes the icons of creates refused at the cap", async () => {
		state.ownedOrganizations = ORGANIZATION_LIMIT - 1;

		const results = await Promise.all(
			Array.from({ length: 5 }, (_, index) =>
				createOrganization(form({ name: `Acme ${index}`, icon: icon() })),
			),
		);

		expect(results.filter((result) => result.success)).toHaveLength(1);
		expect(state.putObject).toHaveBeenCalledTimes(5);
		expect(state.deleteObject).toHaveBeenCalledTimes(4);
		const kept = state.putObject.mock.calls
			.map(([key]) => key)
			.filter(
				(key) => !state.deleteObject.mock.calls.some(([gone]) => gone === key),
			);
		expect(kept).toHaveLength(1);
	});

	it("needs the row lock to hold the cap", async () => {
		state.lockRows = false;
		state.ownedOrganizations = ORGANIZATION_LIMIT - 3;

		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				createOrganization(form({ name: `Acme ${index}` })),
			),
		);

		expect(state.ownedOrganizations).toBeGreaterThan(ORGANIZATION_LIMIT);
	});
});

describe("space creation limits", () => {
	it("creates a space with an icon for a normal user", async () => {
		state.spacesInOrganization = 4;

		const result = await createSpace(form({ name: "Design", icon: icon() }));

		expect(result).toMatchObject({ success: true, iconUrl: "icon-key" });
		expect(state.uploadSpaceIcon).toHaveBeenCalledOnce();
		expect(state.events).toEqual([
			"lock:organizations",
			"count:spaces",
			"insert:spaces",
			"insert:space_members",
		]);
	});

	it("refuses a user creating spaces too quickly", async () => {
		state.rateLimited.add("rl_space_create|space-create:user-1");

		const result = await createSpace(form({ name: "Design", icon: icon() }));

		expect(result).toEqual({ success: false, error: SPACE_RATE_MESSAGE });
		expect(state.uploadSpaceIcon).not.toHaveBeenCalled();
		expect(state.events).toEqual([]);
	});

	it("refuses an organization at the cap without storing anything", async () => {
		state.spacesInOrganization = SPACE_LIMIT;

		const result = await createSpace(form({ name: "Design", icon: icon() }));

		expect(result).toEqual({ success: false, error: SPACE_LIMIT_MESSAGE });
		expect(state.uploadSpaceIcon).not.toHaveBeenCalled();
		expect(state.events).not.toContain("insert:spaces");
	});

	it("never passes the cap with concurrent creates", async () => {
		state.spacesInOrganization = SPACE_LIMIT - 2;

		const results = await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				createSpace(form({ name: `Design ${index}` })),
			),
		);

		expect(results.filter((result) => result.success)).toHaveLength(2);
		expect(state.spacesInOrganization).toBe(SPACE_LIMIT);
	});
});
