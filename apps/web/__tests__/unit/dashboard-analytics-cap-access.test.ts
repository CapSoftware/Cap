import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/dashboard/analytics/route";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	getOrgAnalyticsData: vi.fn(),
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
	const { AgentManagement } = await import(
		"../../../../packages/web-backend/src/AgentManagement"
	);
	return { AgentManagement };
});
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	const { Database } = await import(
		"../../../../packages/web-backend/src/Database"
	);
	return {
		runPromise: <A, E>(
			effect: import("effect").Effect.Effect<
				A,
				E,
				InstanceType<typeof Database>
			>,
		) => Effect.runPromise(Effect.provide(effect, Database.Default)),
	};
});
vi.mock("@/app/(org)/dashboard/analytics/data", () => ({
	getOrgAnalyticsData: mocks.getOrgAnalyticsData,
}));

type CapAccessRow = {
	orgId: string;
	ownerId: string;
	sharedWithOrganization: number | string;
	inOrganizationSpace: number | string;
};

const capRow = (overrides: Partial<CapAccessRow> = {}) => {
	const row: CapAccessRow = {
		orgId: "org-2",
		ownerId: "someone-else",
		sharedWithOrganization: 0,
		inOrganizationSpace: 0,
		...overrides,
	};
	return [
		row.orgId,
		row.ownerId,
		row.sharedWithOrganization,
		row.inOrganizationSpace,
	];
};

const request = (params: Record<string, string>) =>
	({
		url: `https://cap.test/api/dashboard/analytics?${new URLSearchParams(params)}`,
	}) as NextRequest;

beforeEach(() => {
	mocks.query.mockReset();
	mocks.query.mockResolvedValue({ rows: [] });
	mocks.getOrgAnalyticsData.mockReset();
	mocks.getOrgAnalyticsData.mockResolvedValue({ counts: {}, capName: "Cap" });
});

describe("dashboard analytics cap access", () => {
	it("skips the cap lookup when no cap is requested", async () => {
		const response = await GET(request({ orgId: "org-1" }));

		expect(response.status).toBe(200);
		expect(mocks.query).not.toHaveBeenCalled();
	});

	it("scopes the share and space lookups to the requested cap and organization", async () => {
		mocks.query.mockResolvedValueOnce({
			rows: [capRow({ orgId: "org-1" })],
		});

		await GET(request({ orgId: "org-1", capId: "cap-1" }));

		expect(mocks.query).toHaveBeenCalledTimes(1);
		const [statement, params] = mocks.query.mock.calls[0] as [
			string,
			unknown[],
		];
		expect(statement).toContain("`shared_videos`");
		expect(statement).toContain("`space_videos`");
		expect(statement).toContain("`spaces`");
		expect(params.filter((value) => value === "cap-1")).toHaveLength(3);
		expect(params.filter((value) => value === "org-1")).toHaveLength(3);
	});

	it.each([
		["a cap owned by the organization", { orgId: "org-1" }],
		["the user's own cap from another organization", { ownerId: "user-1" }],
		["a cap shared into the organization", { sharedWithOrganization: 1 }],
		["a cap added to a space in the organization", { inOrganizationSpace: 1 }],
		["a share flag returned as a string", { sharedWithOrganization: "1" }],
	])("allows %s", async (_, overrides) => {
		mocks.query.mockResolvedValueOnce({ rows: [capRow(overrides)] });

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

	it("allows a cap together with an accessible space", async () => {
		mocks.query
			.mockResolvedValueOnce({
				rows: [["org-1", "user-1", "Private", null, "member"]],
			})
			.mockResolvedValueOnce({ rows: [capRow({ inOrganizationSpace: 1 })] });

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

	it("rejects a cap from another organization that was never shared in", async () => {
		mocks.query.mockResolvedValueOnce({ rows: [capRow()] });

		const response = await GET(request({ orgId: "org-1", capId: "cap-1" }));

		expect(response.status).toBe(403);
		expect(mocks.getOrgAnalyticsData).not.toHaveBeenCalled();
	});

	it("rejects a cap that does not exist", async () => {
		const response = await GET(request({ orgId: "org-1", capId: "missing" }));

		expect(response.status).toBe(403);
		expect(mocks.getOrgAnalyticsData).not.toHaveBeenCalled();
	});

	it("rejects a cap when the space check fails first", async () => {
		mocks.query.mockResolvedValueOnce({
			rows: [["org-2", "user-1", "Private", null, "owner"]],
		});

		const response = await GET(
			request({ orgId: "org-1", spaceId: "space-1", capId: "cap-1" }),
		);

		expect(response.status).toBe(403);
		expect(mocks.query).toHaveBeenCalledTimes(1);
		expect(mocks.getOrgAnalyticsData).not.toHaveBeenCalled();
	});
});
