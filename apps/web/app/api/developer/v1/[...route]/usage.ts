import { Hono } from "hono";
import {
	MICRO_CREDITS_PER_DOLLAR,
	SPEECH_DOLLARS_PER_HOUR,
	UPLOAD_ADMISSION_DAYS,
} from "@/lib/developer-pricing";
import { getSpeechUsage } from "@/lib/developer-transcript-usage";
import {
	INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES,
	INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
} from "@/lib/infra-pricing";
import {
	getInfraBilling,
	infraBillingJson,
	infraStorageJson,
} from "@/lib/infra-standing";
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

	const [billing, credit] = await Promise.all([
		getInfraBilling(appId),
		getSpeechUsage(appId),
	]);
	const { stored, storage } = billing;

	const { balanceMicroCredits, ...speech } = credit;
	const { standing, upload } = infraBillingJson(billing);

	return c.json({
		data: {
			appId,
			balanceMicroCredits,
			balanceDollars: creditDollars(balanceMicroCredits),
			totalVideos: stored.videoCount,
			uploadingVideos: storage.uploadingVideos,
			totalDurationMinutes: stored.totalMinutes,
			standing,
			upload,
			storage: {
				...infraStorageJson(storage),
				storedMonthlyMicroCredits: Math.round(stored.monthlyMicroCredits),
			},
			...speech,
			rates: {
				microCreditsPerDollar: MICRO_CREDITS_PER_DOLLAR,
				storageDollarsPer1000MinutesPerMonth:
					INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
				deliveryDollarsPer1000Minutes: INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES,
				speechDollarsPerHour: SPEECH_DOLLARS_PER_HOUR,
				uploadAdmissionDays: UPLOAD_ADMISSION_DAYS,
			},
		},
	});
});
