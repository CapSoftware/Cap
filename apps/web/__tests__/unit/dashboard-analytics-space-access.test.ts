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

type SpaceAccessRow = {
	organizationId: string;
	createdById: string;
	privacy: "Public" | "Private";
	memberRole: string | null;
	organizationRole: string;
};

const spaceRow = (overrides: Partial<SpaceAccessRow> = {}) => {
	const row: SpaceAccessRow = {
		organizationId: "org-1",
		createdById: "someone-else",
		privacy: "Private",
		memberRole: null,
		organizationRole: "member",
		...overrides,
	};
	return [
		row.organizationId,
		row.createdById,
		row.privacy,
		row.memberRole,
		row.organizationRole,
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
	mocks.getOrgAnalyticsData.mockResolvedValue({ counts: {} });
});

describe("dashboard analytics space access", () => {
	it("loads organization analytics without a space", async () => {
		const response = await GET(request({ orgId: "org-1" }));

		expect(response.status).toBe(200);
		expect(mocks.query).not.toHaveBeenCalled();
		expect(mocks.getOrgAnalyticsData).toHaveBeenCalledWith(
			"org-1",
			"7d",
			undefined,
			undefined,
		);
	});

	it("loads the organization-wide entry without a space lookup", async () => {
		const response = await GET(request({ orgId: "org-1", spaceId: "org-1" }));

		expect(response.status).toBe(200);
		expect(mocks.query).not.toHaveBeenCalled();
		expect(mocks.getOrgAnalyticsData).toHaveBeenCalledWith(
			"org-1",
			"7d",
			"org-1",
			undefined,
		);
	});

	it.each([
		["space creator", { createdById: "user-1" }],
		["space member", { memberRole: "member" }],
		["space admin", { memberRole: "admin" }],
		["organization owner", { organizationRole: "owner" }],
		["organization admin", { organizationRole: "admin" }],
		["organization member on a public space", { privacy: "Public" as const }],
	])("allows the %s", async (_, overrides) => {
		mocks.query.mockResolvedValueOnce({ rows: [spaceRow(overrides)] });

		const response = await GET(
			request({ orgId: "org-1", spaceId: "space-1", range: "30d" }),
		);

		expect(response.status).toBe(200);
		expect(mocks.getOrgAnalyticsData).toHaveBeenCalledWith(
			"org-1",
			"30d",
			"space-1",
			undefined,
		);
	});

	it("rejects an organization member outside a private space", async () => {
		mocks.query.mockResolvedValueOnce({ rows: [spaceRow()] });

		const response = await GET(request({ orgId: "org-1", spaceId: "space-1" }));

		expect(response.status).toBe(403);
		expect(mocks.getOrgAnalyticsData).not.toHaveBeenCalled();
	});

	it("rejects a space the user has no organization membership for", async () => {
		const response = await GET(request({ orgId: "org-1", spaceId: "space-1" }));

		expect(response.status).toBe(403);
		expect(mocks.getOrgAnalyticsData).not.toHaveBeenCalled();
	});

	it("rejects a space from another organization", async () => {
		mocks.query.mockResolvedValueOnce({
			rows: [spaceRow({ organizationId: "org-2", createdById: "user-1" })],
		});

		const response = await GET(request({ orgId: "org-1", spaceId: "space-1" }));

		expect(response.status).toBe(403);
		expect(mocks.getOrgAnalyticsData).not.toHaveBeenCalled();
	});
});
