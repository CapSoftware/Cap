import { audienceFilter, condition } from "./audiences";
import type { Journey } from "./types";

export const workflowAudience = (journey: Journey) => ({
	match: "all" as const,
	conditions: [
		...audienceFilter(journey.audience, journey.promotional).conditions,
		condition("capLifecycleEnabled", true),
		condition("capOnboardingEligible", true),
		...(journey.key === "free-v2"
			? [condition("capLifecycleStage", "free-v2")]
			: []),
	],
});

export const heldWorkflowAudience = (journey: Journey) => ({
	...workflowAudience(journey),
	conditions: [
		...workflowAudience(journey).conditions,
		condition("subscribed", false),
	],
});
