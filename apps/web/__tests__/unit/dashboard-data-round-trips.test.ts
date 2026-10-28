import { createHash } from "node:crypto";
import type { userSelectProps } from "@cap/database/auth/session";
import { Organisation } from "@cap/web-domain";
import { Context, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});
vi.mock("@cap/env", () => ({ buildEnv: { NEXT_PUBLIC_IS_CAP: true } }));
vi.mock(
	"@cap/utils",
	async () => import("../../../../packages/utils/src/constants/plans"),
);
vi.mock("@cap/web-backend", () => ({
	Database: Context.GenericTag("DashboardPerfDatabase"),
	ImageUploads: Context.GenericTag("DashboardPerfImages"),
}));
vi.mock("@/lib/server", async () => {
	const { db } = await import("@cap/database");
	return {
		runPromise: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
			effect.pipe(
				Effect.provideService(Context.GenericTag("DashboardPerfDatabase"), {
					use: <T>(callback: (client: ReturnType<typeof db>) => Promise<T>) =>
						Effect.promise(() => callback(db())),
				}),
				Effect.provideService(Context.GenericTag("DashboardPerfImages"), {
					resolveImageUrl: (url: string) => Effect.succeed(`resolved:${url}`),
				}),
				Effect.runPromise,
			),
	};
});

import {
	getDashboardData,
	getDashboardSpacesData,
} from "@/app/(org)/dashboard/dashboard-data";

type Row = Record<string, unknown>;
const createdAt = "2026-10-20 12:00:00";
const user = {
	id: "viewer",
	activeOrganizationId: "org-0",
	preferences: null,
} as typeof userSelectProps;
let orgs: Row[];
let members: Row[];
let invites: Row[];
let people: Row[];
let hasNotification: boolean;

function fixture(organizationCount = 1) {
	orgs = Array.from({ length: organizationCount }, (_, i) => ({
		id: `org-${i}`,
		name: `Team ${i}`,
		ownerId: i < 2 ? "owner-0" : `owner-${i}`,
		createdAt,
		updatedAt: createdAt,
		settings: { disableComments: true },
		iconUrl: `org-${i}/icon.png`,
		shareableLinkIconUrl: i === 0 ? "org-0/share.png" : null,
	}));
	orgs.push(
		{ id: "other-owned", ownerId: "owner-0" },
		{ id: "deleted", ownerId: "owner-0", tombstoneAt: createdAt },
	);
	members = orgs.flatMap((org) =>
		Array.from({ length: 50 }, (_, i) => ({
			id: `${org.id}-member-${i}`,
			organizationId: org.id,
			userId:
				i === 0 && String(org.id).startsWith("org-") ? "viewer" : `person-${i}`,
			role: i === 0 ? "admin" : "member",
			hasProSeat: i % 2,
			createdAt,
			updatedAt: createdAt,
		})),
	);
	invites = orgs.flatMap((org) =>
		["pending", "accepted"].map((status) => ({
			id: `${org.id}-${status}`,
			organizationId: org.id,
			invitedEmail: `${status}@example.com`,
			invitedByUserId: org.ownerId,
			role: "member",
			status,
			createdAt,
			updatedAt: createdAt,
		})),
	);
	people = [
		"viewer",
		...Array.from({ length: 49 }, (_, i) => `person-${i + 1}`),
		...orgs.map((org) => String(org.ownerId)),
	].map((id) => ({
		id,
		name: id,
		email: `${id}@example.com`,
		image: id === "person-1" ? null : `${id}/avatar.png`,
		inviteQuota: id === "viewer" ? 80 : 60,
		stripeSubscriptionId: `sub-${id}`,
		stripeSubscriptionStatus: "active",
	}));
	hasNotification = true;
}

function project(query: string, tables: Record<string, Row>) {
	const primary = / from `(\w+)`/.exec(query)?.[1] ?? "";
	return query
		.slice(7, query.indexOf(" from "))
		.split(", ")
		.map((column) => {
			const match = /^`(\w+)`(?:\.`(\w+)`)?$/.exec(column);
			if (!match) throw new Error(`Unexpected projection: ${column}`);
			const value =
				tables[match[2] ? (match[1] ?? "") : primary]?.[
					match[2] ?? match[1] ?? ""
				];
			return value ?? null;
		});
}

function rowsFor(query: string, params: unknown[]) {
	const visible = orgs.filter((org) => String(org.id).startsWith("org-"));
	if (
		query.includes("from `organization_members` inner join `organizations`") &&
		!query.includes("count(")
	) {
		return visible
			.filter((org) =>
				members.some(
					(member) =>
						member.organizationId === org.id && member.userId === params[0],
				),
			)
			.map((org) => project(query, { organizations: org }));
	}
	if (
		query.includes("count(") &&
		query.includes("group by `organizations`.`ownerId`")
	) {
		expect(query).toContain("`organizations`.`tombstoneAt` is null");
		const rows = query.includes("`organization_invites`") ? invites : members;
		return [...new Set(orgs.map((org) => org.ownerId))]
			.filter((id) => params.includes(id))
			.map((ownerId) => [
				ownerId,
				rows.filter((row) =>
					orgs.some(
						(org) =>
							org.id === row.organizationId &&
							org.ownerId === ownerId &&
							!org.tombstoneAt,
					),
				).length,
			])
			.filter(([, total]) => Number(total) > 0);
	}
	if (query.includes("from `organizations`")) {
		if (query.startsWith("select `id`")) {
			return orgs
				.filter((org) => org.ownerId === params[0] && !org.tombstoneAt)
				.map((org) => [org.id]);
		}
		return visible
			.filter((org) => org.ownerId === params[0])
			.map((org) => project(query, { organizations: org }));
	}
	if (query.includes("from `organization_members`")) {
		if (query.includes("count(") || query.includes("COUNT("))
			return [
				[members.filter((row) => params.includes(row.organizationId)).length],
			];
		if (query.startsWith("select `role`")) return [["admin"]];
		return members
			.filter((row) => params.includes(row.organizationId))
			.map((row) =>
				project(query, {
					organization_members: row,
					users: people.find((person) => person.id === row.userId) ?? {},
				}),
			);
	}
	if (query.includes("from `organization_invites`")) {
		if (query.includes("count("))
			return [
				[invites.filter((row) => params.includes(row.organizationId)).length],
			];
		return invites
			.filter((row) => params.includes(row.organizationId))
			.map((row) => project(query, { organization_invites: row }));
	}
	if (query.includes("from `users`"))
		return people
			.filter(
				(person, i) =>
					params.includes(person.id) &&
					people.findIndex((p) => p.id === person.id) === i,
			)
			.map((person) => project(query, { users: person }));
	if (query.includes("from `notifications`"))
		return hasNotification ? [["notification-1"]] : [];
	if (query.includes("from `shared_videos`")) return [[125]];
	if (query.includes("from `videos`")) return [[20]];
	if (query.includes("from `spaces`"))
		return Array.from({ length: 10 }, (_, i) => [
			`space-${i}`,
			0,
			"Public",
			0,
			`Space ${i}`,
			null,
			params[0],
			"owner-0",
			i % 2 ? null : `space-${i}/icon.png`,
			{},
			i === 0 ? "admin" : null,
			i % 2,
			50,
			25,
		]);
	throw new Error(`Unexpected query: ${query}`);
}

function hash(value: unknown) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function countRoundTrips() {
	const pending: Array<() => void> = [];
	mocks.query.mockImplementation(
		(query: string, params: unknown[]) =>
			new Promise((resolve) =>
				pending.push(() => resolve({ rows: rowsFor(query, params) })),
			),
	);
	let settled = false;
	const load = getDashboardData(user).finally(() => {
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
	return {
		result: await load,
		roundTrips,
		queries: mocks.query.mock.calls.length,
	};
}

beforeEach(() => {
	fixture();
	mocks.query.mockReset();
	mocks.query.mockImplementation(async (query: string, params: unknown[]) => ({
		rows: rowsFor(query, params),
	}));
});

describe("dashboard organization loading", () => {
	it.each([1, 4])(
		"preserves sidebar data for %i organizations",
		async (size) => {
			fixture(size);
			const { result, roundTrips, queries } = await countRoundTrips();
			expect(result.organizationSelect).toHaveLength(size);
			expect(result.spacesData).toHaveLength(11);
			expect(result.organizationSelect[0]).toMatchObject({
				inviteQuota: 80,
				totalInvites: size === 1 ? 104 : 156,
				ownerIsPro: true,
				hasActiveProSeatProvider: true,
			});
			expect(result.organizationSelect[0]?.members).toHaveLength(50);
			expect(result.organizationSelect[0]?.invites).toHaveLength(2);
			expect(result).toMatchObject({
				anyNewNotifications: true,
				userCapsCount: 20,
				organizationSettings: { disableComments: true },
			});
			console.log(
				JSON.stringify({ size, roundTrips, queries, output: hash(result) }),
			);
			expect(hash(result)).toBe(
				size === 1
					? "af7e1b54614e4e2675db8311985b52a706a8da9284fe5bc193fd4e8de5c00c58"
					: "cf91e6f9c8090b7b718cab9d467ef658865ce96594875143107388b6700b98fe",
			);
			expect(roundTrips).toBe(3);
			expect(queries).toBe(13);
		},
	);

	it("returns empty data without organization queries for a user with no organizations", async () => {
		orgs = [];
		const result = await getDashboardData(user);
		expect(result).toEqual({
			organizationSelect: [],
			organizationSettings: null,
			spacesData: [],
			anyNewNotifications: false,
			userPreferences: { preferences: null },
			userCapsCount: 0,
		});
		expect(mocks.query).toHaveBeenCalledTimes(2);
	});

	it("keeps the existing empty fallback on query failure", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.query.mockRejectedValue(new Error("database unavailable"));
		expect(await getDashboardData(user)).toEqual({
			organizationSelect: [],
			spacesData: [],
			userCapsCount: null,
			anyNewNotifications: false,
			userPreferences: null,
			organizationSettings: null,
		});
	});

	it("keeps space-only loading and dashboard space data identical", async () => {
		const result = await getDashboardData(user);
		expect(await getDashboardSpacesData(user)).toEqual(result.spacesData);
	});

	it("refreshes notification state and handles a stale active organization", async () => {
		hasNotification = false;
		const result = await getDashboardData({
			...user,
			activeOrganizationId: Organisation.OrganisationId.make("stale"),
		});
		expect(result.anyNewNotifications).toBe(false);
		expect(result.spacesData[0]?.id).toBe("org-0");
		hasNotification = true;
		expect((await getDashboardData(user)).anyNewNotifications).toBe(true);
	});

	it("defaults owner-wide totals to zero when there are no members or invites", async () => {
		if (orgs[0]) orgs[0].ownerId = "viewer";
		members = [];
		invites = [];
		const result = await getDashboardData(user);
		expect(result.organizationSelect[0]).toMatchObject({
			members: [],
			invites: [],
			totalInvites: 0,
		});
	});

	it("keeps the existing fallback when a member's user row is missing", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		people = people.filter((person) => person.id !== "person-1");
		expect((await getDashboardData(user)).userCapsCount).toBeNull();
	});

	it.skipIf(!process.env.CAP_DASHBOARD_DATA_BENCH)(
		"measures dashboard loads with simulated 20ms database latency",
		async () => {
			for (const size of [1, 4]) {
				fixture(size);
				mocks.query.mockClear();
				mocks.query.mockImplementation(
					async (query: string, params: unknown[]) => {
						await new Promise((resolve) => setTimeout(resolve, 20));
						return { rows: rowsFor(query, params) };
					},
				);
				const samples: number[] = [];
				const outputs = new Set<string>();
				for (let i = 0; i < 22; i++) {
					const start = performance.now();
					const result = await getDashboardData(user);
					if (i > 0) samples.push(performance.now() - start);
					outputs.add(hash(result));
				}
				samples.sort((a, b) => a - b);
				expect(outputs.size).toBe(1);
				console.log(
					JSON.stringify({
						size,
						medianMs: samples[10],
						queries: mocks.query.mock.calls.length / 22,
						output: [...outputs][0],
					}),
				);
			}
		},
	);
});
