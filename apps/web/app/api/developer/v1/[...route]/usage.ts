import { db } from "@cap/database";
import { developerCreditAccounts, developerVideos } from "@cap/database/schema";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { withDeveloperSecretAuth } from "../../../utils";

export const app = new Hono<{
	Variables: {
		developerAppId: string;
		developerKeyType: "secret";
	};
}>().use(withDeveloperSecretAuth);

app.get("/", async (c) => {
	const appId = c.get("developerAppId");

	const [[account], [videoStats]] = await Promise.all([
		db()
			.select()
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.appId, appId))
			.limit(1),
		db()
			.select({
				totalVideos: count(),
				totalDurationMinutes: sql<number>`COALESCE(SUM(${developerVideos.duration}) / 60, 0)`,
			})
			.from(developerVideos)
			.where(
				and(
					eq(developerVideos.appId, appId),
					isNull(developerVideos.deletedAt),
				),
			),
	]);

	return c.json({
		data: {
			balanceMicroCredits: account?.balanceMicroCredits ?? 0,
			balanceDollars: ((account?.balanceMicroCredits ?? 0) / 100_000).toFixed(
				2,
			),
			totalVideos: videoStats?.totalVideos ?? 0,
			totalDurationMinutes: videoStats?.totalDurationMinutes ?? 0,
		},
	});
});
