import type { SlackEventPayload } from "@/lib/slack/unfurl";
import { processSlackEvent } from "@/lib/slack/unfurl";

type ProcessableSlackEventPayload = Exclude<
	SlackEventPayload,
	{ type: "url_verification" }
>;

async function processSlackEventStep(
	payload: ProcessableSlackEventPayload,
	webUrl: string,
) {
	"use step";

	await processSlackEvent({ payload, webUrl });
}
processSlackEventStep.maxRetries = 5;

export async function slackEventWorkflow(
	payload: ProcessableSlackEventPayload,
	webUrl: string,
) {
	"use workflow";

	await processSlackEventStep(payload, webUrl);
}
