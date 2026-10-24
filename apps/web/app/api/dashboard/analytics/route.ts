import { getCurrentUser } from "@cap/database/auth/session";
import { AgentManagement } from "@cap/web-backend";
import { Space, type User } from "@cap/web-domain";
import { Effect } from "effect";
import type { NextRequest } from "next/server";

import { getOrgAnalyticsData } from "@/app/(org)/dashboard/analytics/data";
import type { AnalyticsRange } from "@/app/(org)/dashboard/analytics/types";
import { runPromise } from "@/lib/server";

const RANGE_VALUES: AnalyticsRange[] = ["24h", "7d", "30d", "lifetime"];

export const dynamic = "force-dynamic";

const canViewSpaceAnalytics = async (
	userId: User.UserId,
	orgId: string,
	spaceId: string,
) => {
	if (spaceId === orgId) return true;

	return Effect.flatMap(AgentManagement, (management) =>
		management.getSpaceAccess(userId, Space.SpaceId.make(spaceId)),
	).pipe(
		Effect.map((access) => access.organizationId === orgId),
		Effect.catchTag("PolicyDenied", () => Effect.succeed(false)),
		Effect.provide(AgentManagement.DefaultWithoutDependencies),
		runPromise,
	);
};

export async function GET(request: NextRequest) {
	const user = await getCurrentUser();
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

	const { searchParams } = new URL(request.url);
	const requestedOrgId = searchParams.get("orgId");
	const orgId = requestedOrgId ?? user.activeOrganizationId;
	const spaceId = searchParams.get("spaceId") ?? undefined;
	const capId = searchParams.get("capId") ?? undefined;

	if (!orgId)
		return Response.json({ error: "No active organization" }, { status: 400 });

	if (requestedOrgId && requestedOrgId !== user.activeOrganizationId) {
		return Response.json({ error: "Forbidden" }, { status: 403 });
	}

	const rangeParam = (searchParams.get("range") ?? "7d") as AnalyticsRange;
	const range: AnalyticsRange = RANGE_VALUES.includes(rangeParam)
		? rangeParam
		: "7d";

	try {
		if (spaceId && !(await canViewSpaceAnalytics(user.id, orgId, spaceId))) {
			return Response.json({ error: "Forbidden" }, { status: 403 });
		}

		const data = await getOrgAnalyticsData(orgId, range, spaceId, capId);
		return Response.json({ data });
	} catch (error) {
		console.error("Failed to load analytics", error);
		return Response.json(
			{ error: "Failed to load analytics" },
			{ status: 500 },
		);
	}
}
