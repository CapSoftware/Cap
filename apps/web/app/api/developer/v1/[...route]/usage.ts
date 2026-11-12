import { db } from "@cap/database";
import { developerCreditAccounts, developerVideos } from "@cap/database/schema";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
	MICRO_CREDITS_PER_DOLLAR,
	SPEECH_DOLLARS_PER_HOUR,
	UPLOAD_ADMISSION_DAYS,
} from "@/lib/developer-pricing";
import { INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH } from "@/lib/infra-pricing";
import { getInfraBilling, infraBillingJson } from "@/lib/infra-standing";
import { withDeveloperSecretAuth } from "../../../utils";

export const app = new Hono<{
	Variables: {
		developerAppId: string;
		developerKeyType: "secret";
	};
}>().use(withDeveloperSecretAuth);

app.get("/", async (c) => {
	const appId = c.get("developerAppId");

	const [[account], [videoStats], billing] = await Promise.all([
		db()
			.select()
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.appId, appId))
			.limit(1),
		db()
			.select({
				createdVideos: count(),
				uploadedVideos: count(developerVideos.duration),
				totalDurationMinutes: sql<number>`COALESCE(SUM(${developerVideos.duration}) / 60, 0)`,
			})
			.from(developerVideos)
			.where(
				and(
					eq(developerVideos.appId, appId),
					isNull(developerVideos.deletedAt),
				),
			),
		getInfraBilling(appId),
	]);

	const uploadedVideos = videoStats?.uploadedVideos ?? 0;

	return c.json({
		data: {
			balanceMicroCredits: account?.balanceMicroCredits ?? 0,
			balanceDollars: (
				(account?.balanceMicroCredits ?? 0) / MICRO_CREDITS_PER_DOLLAR
			).toFixed(2),
			totalVideos: uploadedVideos,
			uploadingVideos: Math.max(
				0,
				(videoStats?.createdVideos ?? 0) - uploadedVideos,
			),
			totalDurationMinutes: videoStats?.totalDurationMinutes ?? 0,
			...infraBillingJson(billing),
			rates: {
				microCreditsPerDollar: MICRO_CREDITS_PER_DOLLAR,
				storageDollarsPer1000MinutesPerMonth:
					INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
				speechDollarsPerHour: SPEECH_DOLLARS_PER_HOUR,
				uploadAdmissionDays: UPLOAD_ADMISSION_DAYS,
			},
		},
	});
});
