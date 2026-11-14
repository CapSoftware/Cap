import { sleep } from "workflow";
import {
	type AppStoreDeliveryJob,
	type DeliveryOutcome,
	deliverAppStoreJob,
} from "@/lib/app-store/delivery";
import { webhookRetryDelaySeconds } from "@/lib/developer-webhook-events";

export async function deliverAppStoreRequestWorkflow(
	job: AppStoreDeliveryJob,
): Promise<{ outcome: DeliveryOutcome | "gave_up"; attempts: number }> {
	"use workflow";

	for (let attempt = 1; ; attempt++) {
		const outcome = await attemptDelivery(job);
		if (outcome !== "retry") return { outcome, attempts: attempt };
		const delay = webhookRetryDelaySeconds(attempt);
		if (delay === null) return { outcome: "gave_up", attempts: attempt };
		await sleep(`${delay}s`);
	}
}

async function attemptDelivery(
	job: AppStoreDeliveryJob,
): Promise<DeliveryOutcome> {
	"use step";

	try {
		return await deliverAppStoreJob(job);
	} catch (error) {
		console.error("[app-store] Delivery attempt failed to run", {
			installationId: job.installationId,
			kind: job.kind,
			message: error instanceof Error ? error.message : String(error),
		});
		return "retry";
	}
}
