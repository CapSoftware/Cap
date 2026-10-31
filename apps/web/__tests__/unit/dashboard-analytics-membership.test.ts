import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/dashboard/analytics/route";

const mocks = vi.hoisted(() => ({
	getOrganizationAccess: vi.fn(),
	getOrgAnalyticsData: vi.fn(),
	canViewSpaceAnalytics: vi.fn(),
	canViewCapAnalytics: vi.fn(),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "user-1", activeOrganizationId: "org-1" }),
}));
vi.mock("@/actions/organization/authorization", () => ({
	getOrganizationAccess: mocks.getOrganizationAccess,
}));
vi.mock("@/app/(org)/dashboard/analytics/data", () => ({
	getOrgAnalyticsData: mocks.getOrgAnalyticsData,
}));
vi.mock("@/lib/space-analytics-access", () => ({
	canViewSpaceAnalytics: mocks.canViewSpaceAnalytics,
}));
vi.mock("@/lib/cap-analytics-access", () => ({
	canViewCapAnalytics: mocks.canViewCapAnalytics,
}));

const request = (params: Record<string, string>) =>
	({
		url: `https://cap.test/api/dashboard/analytics?${new URLSearchParams(params)}`,
	}) as NextRequest;

const memberAccess = {
	id: "org-1",
	ownerId: "owner-1",
	memberId: "member-1",
	role: "member",
};

beforeEach(() => {
	mocks.getOrganizationAccess.mockReset();
	mocks.getOrganizationAccess.mockResolvedValue(memberAccess);
	mocks.getOrgAnalyticsData.mockReset();
	mocks.getOrgAnalyticsData.mockResolvedValue({ counts: {} });
	mocks.canViewSpaceAnalytics.mockReset();
	mocks.canViewSpaceAnalytics.mockResolvedValue(true);
	mocks.canViewCapAnalytics.mockReset();
	mocks.canViewCapAnalytics.mockResolvedValue(true);
});

describe("dashboard analytics organization membership", () => {
	it.each<{ name: string; params: Record<string, string> }>([
		{ name: "the active organization", params: { range: "lifetime" } },
		{ name: "an explicit organization", params: { orgId: "org-1" } },
		{ name: "a cap", params: { capId: "cap-1" } },
		{ name: "a space", params: { spaceId: "space-1" } },
		{ name: "the organization-wide entry", params: { spaceId: "org-1" } },
	])(
		"rejects $name once the user is no longer in the organization",
		async ({ params }) => {
			mocks.getOrganizationAccess.mockResolvedValue(null);

			const response = await GET(request(params));

			expect(response.status).toBe(403);
			expect(mocks.getOrganizationAccess).toHaveBeenCalledWith(
				"user-1",
				"org-1",
			);
			expect(mocks.getOrgAnalyticsData).not.toHaveBeenCalled();
		},
	);

	it("loads analytics for a current member", async () => {
		const response = await GET(request({ range: "30d" }));

		expect(response.status).toBe(200);
		expect(mocks.getOrganizationAccess).toHaveBeenCalledWith("user-1", "org-1");
		expect(mocks.getOrgAnalyticsData).toHaveBeenCalledWith(
			"org-1",
			"30d",
			undefined,
			undefined,
		);
	});

	it("keeps rejecting an organization other than the active one", async () => {
		const response = await GET(request({ orgId: "org-2" }));

		expect(response.status).toBe(403);
		expect(mocks.getOrgAnalyticsData).not.toHaveBeenCalled();
	});

	it("returns a server error when the membership lookup fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.getOrganizationAccess.mockRejectedValue(new Error("Database down"));

		const response = await GET(request({ range: "7d" }));

		expect(response.status).toBe(500);
		expect(mocks.getOrgAnalyticsData).not.toHaveBeenCalled();
	});
});
