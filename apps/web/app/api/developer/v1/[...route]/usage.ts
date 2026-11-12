import { db } from "@cap/database";
import { developerVideos } from "@cap/database/schema";
import { and, count, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import {
	MICRO_CREDITS_PER_DOLLAR,
	SPEECH_DOLLARS_PER_HOUR,
	UPLOAD_ADMISSION_DAYS,
} from "@/lib/developer-pricing";
import { getSpeechUsage } from "@/lib/developer-transcript-usage";
import { INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH } from "@/lib/infra-pricing";
import {
	getInfraBilling,
	infraBillingJson,
	infraStorageJson,
} from "@/lib/infra-standing";
import { getAppStorageUsage } from "@/lib/infra-storage";
import { creditDollars } from "@/lib/infra-usage";
import { withDeveloperSecretAuth } from "../../../utils";

export const app = new Hono<{
	Variables: {
		developerAppId: string;
		developerKeyType: "secret";
	};
}>().use(withDeveloperSecretAuth);

app.get("/", async (c) => {
	const appId = c.get("developerAppId");

	const [[videoStats], billing, stored, credit] = await Promise.all([
		db()
			.select({
				createdVideos: count(),
				uploadedVideos: count(developerVideos.duration),
			})
			.from(developerVideos)
			.where(
				and(
					eq(developerVideos.appId, appId),
					isNull(developerVideos.deletedAt),
				),
			),
		getInfraBilling(appId),
		getAppStorageUsage(appId),
		getSpeechUsage(appId),
	]);

	const { balanceMicroCredits, ...speech } = credit;
	const { standing, upload } = infraBillingJson(billing);

	return c.json({
		data: {
			balanceMicroCredits,
			balanceDollars: creditDollars(balanceMicroCredits),
			totalVideos: stored.videoCount,
			uploadingVideos: Math.max(
				0,
				(videoStats?.createdVideos ?? 0) - (videoStats?.uploadedVideos ?? 0),
			),
			totalDurationMinutes: stored.totalMinutes,
			standing,
			upload,
			storage: infraStorageJson(stored),
			...speech,
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
