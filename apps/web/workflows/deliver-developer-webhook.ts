import { sleep } from "workflow";
import { deliverDeveloperWebhookAttempt } from "@/lib/developer-webhook-delivery";
import {
	type WebhookDeliveryJob,
	type WebhookDeliveryOutcome,
	webhookRetryDelaySeconds,
} from "@/lib/developer-webhook-events";

export async function deliverDeveloperWebhookWorkflow(
	job: WebhookDeliveryJob,
): Promise<{ outcome: WebhookDeliveryOutcome | "gave_up"; attempts: number }> {
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
	job: WebhookDeliveryJob,
): Promise<WebhookDeliveryOutcome> {
	"use step";

	// A thrown step is run again by the engine straight away and then fails
	// the run. Returning "retry" keeps a database blip on the same schedule
	// as a failed delivery.
	try {
		return await deliverDeveloperWebhookAttempt(job);
	} catch (error) {
		console.error("[developer-webhook] Delivery attempt failed to run", {
			endpointId: job.endpointId,
			eventId: job.eventId,
			message: error instanceof Error ? error.message : String(error),
		});
		return "retry";
	}
}
