import { drainProductAnalyticsOutbox } from "@/lib/analytics/product-event-outbox";

async function drainProductAnalyticsOutboxStep() {
	"use step";
	return drainProductAnalyticsOutbox();
}
drainProductAnalyticsOutboxStep.maxRetries = 4;

export async function drainProductAnalyticsOutboxWorkflow() {
	"use workflow";
	return drainProductAnalyticsOutboxStep();
}
