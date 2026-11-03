import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/dashboard/analytics/route";

type TinybirdStub = {
	querySql: (
		statement: string,
	) => import("effect").Effect.Effect<{ data: unknown[] }>;
};

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	getOrgAnalyticsData: vi.fn(),
	topCapRows: [] as { pathname: string; views: number }[],
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
vi.mock("@cap/web-backend", async () => {
	const { Context } = await import("effect");
	const { AgentManagement } = await import(
		"../../../../packages/web-backend/src/AgentManagement"
	);
	return {
		AgentManagement,
		Tinybird: Context.GenericTag<TinybirdStub>("Tinybird"),
	};
});
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	const { Tinybird } = (await import("@cap/web-backend")) as unknown as {
		Tinybird: import("effect").Context.Tag<TinybirdStub, TinybirdStub>;
	};
	const { Database } = await import(
		"../../../../packages/web-backend/src/Database"
	);
	return {
		runPromise: <A, E>(
			effect: import("effect").Effect.Effect<
				A,
				E,
				InstanceType<typeof Database> | TinybirdStub
			>,
		) =>
			Effect.runPromise(
				effect.pipe(
					Effect.provideService(Tinybird, {
						querySql: (statement: string) =>
							Effect.succeed({
								data: statement.includes("GROUP BY pathname")
									? mocks.topCapRows
									: [],
							}),
					}),
					Effect.provide(Database.Default),
				),
			),
	};
});
vi.mock("@/app/(org)/dashboard/analytics/data", () => ({
	getOrgAnalyticsData: mocks.getOrgAnalyticsData,
}));

const request = (params: Record<string, string>) =>
	({
		url: `https://cap.test/api/dashboard/analytics?${new URLSearchParams(params)}`,
	}) as NextRequest;

const spaceRow = (organizationId: string, organizationRole: string) => [
	organizationId,
	"user-1",
	"Private",
	null,
	organizationRole,
];

const expectOrganizationScope = (statement: string, params: unknown[]) => {
	expect(statement).toContain("`videos`.`orgId` = ?");
	expect(statement).toContain("exists (select `id` from `shared_videos` where");
	expect(statement).toContain(
		"`shared_videos`.`videoId` = `videos`.`id` and `shared_videos`.`organizationId` = ?",
	);
	expect(statement).toContain(
		"left join `spaces` on `spaces`.`id` = `space_videos`.`spaceId`",
	);
	expect(statement).toContain(
		"`space_videos`.`videoId` = `videos`.`id` and (`space_videos`.`spaceId` = ? or `spaces`.`organizationId` = ?)",
	);
	expect(params.filter((value) => value === "org-1")).toHaveLength(4);
};

beforeEach(() => {
	mocks.query.mockReset();
	mocks.query.mockResolvedValue({ rows: [] });
	mocks.getOrgAnalyticsData.mockReset();
	mocks.getOrgAnalyticsData.mockResolvedValue({ counts: {}, capName: "Cap" });
	mocks.topCapRows = [];
});

describe("dashboard analytics cap access", () => {
	it("skips the cap lookup when no cap is requested", async () => {
		const response = await GET(request({ orgId: "org-1" }));

		expect(response.status).toBe(200);
		expect(mocks.query).not.toHaveBeenCalled();
	});

	it("matches the cap by owner or by its place in the organization", async () => {
		await GET(request({ orgId: "org-1", capId: "cap-1" }));

		expect(mocks.query).toHaveBeenCalledTimes(1);
		const [statement, params] = mocks.query.mock.calls[0] as [
			string,
			unknown[],
		];
		expect(statement).toContain("`videos`.`id` = ?");
		expect(statement).toContain("`videos`.`ownerId` = ?");
		expectOrganizationScope(statement, params);
		expect(params).toContain("cap-1");
		expect(params).toContain("user-1");
	});

	it("loads the cap analytics when the cap matches", async () => {
		mocks.query.mockResolvedValueOnce({ rows: [["cap-1"]] });

		const response = await GET(
			request({ orgId: "org-1", capId: "cap-1", range: "30d" }),
		);

		expect(response.status).toBe(200);
		expect(mocks.getOrgAnalyticsData).toHaveBeenCalledWith(
			"org-1",
			"30d",
			undefined,
			"cap-1",
		);
		await expect(response.json()).resolves.toEqual({
			data: { counts: {}, capName: "Cap" },
		});
	});

	it("loads a cap together with an accessible space", async () => {
		mocks.query
			.mockResolvedValueOnce({ rows: [spaceRow("org-1", "member")] })
			.mockResolvedValueOnce({ rows: [["cap-1"]] });

		const response = await GET(
			request({ orgId: "org-1", spaceId: "space-1", capId: "cap-1" }),
		);

		expect(response.status).toBe(200);
		expect(mocks.getOrgAnalyticsData).toHaveBeenCalledWith(
			"org-1",
			"7d",
			"space-1",
			"cap-1",
		);
	});

	it("rejects a cap that does not match the user or the organization", async () => {
		const response = await GET(request({ orgId: "org-1", capId: "cap-2" }));

		expect(response.status).toBe(403);
		expect(mocks.query).toHaveBeenCalledTimes(1);
		expect(mocks.getOrgAnalyticsData).not.toHaveBeenCalled();
	});

	it("rejects a cap when the space check fails first", async () => {
		mocks.query.mockResolvedValueOnce({ rows: [spaceRow("org-2", "owner")] });

		const response = await GET(
			request({ orgId: "org-1", spaceId: "space-1", capId: "cap-1" }),
		);

		expect(response.status).toBe(403);
		expect(mocks.query).toHaveBeenCalledTimes(1);
		expect(mocks.getOrgAnalyticsData).not.toHaveBeenCalled();
	});
});

describe("dashboard analytics top cap names", () => {
	it("names only the top caps that belong to the organization", async () => {
		const { getOrgAnalyticsData } = await vi.importActual<
			typeof import("@/app/(org)/dashboard/analytics/data")
		>("@/app/(org)/dashboard/analytics/data");
		mocks.topCapRows = [
			{ pathname: "/s/cap-in-org", views: 3 },
			{ pathname: "/s/cap-elsewhere", views: 1 },
		];
		mocks.query.mockImplementation(async (statement: string) => ({
			rows: statement.startsWith("select `id`, `name` from `videos`")
				? [["cap-in-org", "Org cap"]]
				: [],
		}));

		const data = await getOrgAnalyticsData("org-1", "7d");

		const nameQuery = mocks.query.mock.calls.find(([statement]) =>
			(statement as string).startsWith("select `id`, `name` from `videos`"),
		) as [string, unknown[]];
		expect(nameQuery[0]).toContain("`videos`.`id` in (?, ?)");
		expectOrganizationScope(nameQuery[0], nameQuery[1]);
		expect(
			data.breakdowns.topCaps.map(({ id, name }) => ({ id, name })),
		).toEqual([
			{ id: "cap-in-org", name: "Org cap" },
			{ id: "cap-elsewhere", name: "cap-elsewhere" },
		]);
	});
});
