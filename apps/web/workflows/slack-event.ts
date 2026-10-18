import { sleep } from "workflow";
import { SlackUnfurlError } from "@/lib/slack/client";
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

	try {
		await processSlackEvent({ payload, webUrl });
	} catch (error) {
		if (error instanceof SlackUnfurlError && !error.retryable) {
			console.error(
				"[slack-unfurl] Permanent Slack API failure",
				error.message,
			);
			return;
		}
		throw error;
	}
}
processSlackEventStep.maxRetries = 5;

export async function slackEventWorkflow(
	payload: ProcessableSlackEventPayload,
	webUrl: string,
) {
	"use workflow";

	let processed = false;
	while (!processed) {
		try {
			await processSlackEventStep(payload, webUrl);
			processed = true;
		} catch (error) {
			console.error(
				"[slack-unfurl] Retrying after step failure",
				error instanceof Error ? error.message : "Unknown error",
			);
			await sleep("5m");
		}
	}
}
