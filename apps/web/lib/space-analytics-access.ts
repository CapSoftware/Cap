import "server-only";

import { AgentManagement } from "@cap/web-backend";
import { Space, type User } from "@cap/web-domain";
import { Effect } from "effect";
import { runPromise } from "@/lib/server";

export const canViewSpaceAnalytics = async (
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
