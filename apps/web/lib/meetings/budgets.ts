import {
	checkFirewallRateLimitUnits,
	consumeRollingBudget,
	getFallbackRateLimit,
	isRateLimited,
	RATE_LIMIT_IDS,
	type RollingBudgetRule,
} from "@/lib/rate-limit";
import { MEETING_CLIP_SAMPLE_RATE } from "./wav";

export type MeetingEndpoint = "transcribe" | "notes" | "ask";

export const MEETING_REQUEST_RULE_IDS = {
	transcribe: RATE_LIMIT_IDS.MEETINGS_TRANSCRIBE,
	notes: RATE_LIMIT_IDS.MEETINGS_NOTES,
	ask: RATE_LIMIT_IDS.MEETINGS_ASK,
} as const satisfies Record<MeetingEndpoint, string>;

export const MEETING_AUDIO_UNIT_SECONDS = 10;

export const MEETING_AUDIO_BUDGET: RollingBudgetRule = getFallbackRateLimit(
	RATE_LIMIT_IDS.MEETINGS_AUDIO,
);

// The firewall does not report when its window frees up; a client that waits
// this long and is still limited simply gets another 429.
export const FIREWALL_RETRY_AFTER_SECONDS = 60;

// The audio window is a day, and every retry that reaches the firewall is
// charged again, so a limited client is told to back off for longer.
export const AUDIO_FIREWALL_RETRY_AFTER_SECONDS = 15 * 60;

export function meetingAudioUnits(samples: number): number {
	return Math.ceil(
		samples / (MEETING_AUDIO_UNIT_SECONDS * MEETING_CLIP_SAMPLE_RATE),
	);
}

export type MeetingBudgetResult =
	| { limited: false }
	| { limited: true; retryAfterSeconds: number };

export function meetingRequestBudget(
	endpoint: MeetingEndpoint,
): RollingBudgetRule {
	return getFallbackRateLimit(MEETING_REQUEST_RULE_IDS[endpoint]);
}

export async function consumeMeetingRequestBudget(
	endpoint: MeetingEndpoint,
	userId: string,
	headers: Headers,
): Promise<MeetingBudgetResult> {
	const ruleId = MEETING_REQUEST_RULE_IDS[endpoint];
	const local = await consumeRollingBudget(ruleId, {
		key: userId,
		rule: meetingRequestBudget(endpoint),
	});
	if (!local.allowed)
		return { limited: true, retryAfterSeconds: local.retryAfterSeconds };

	if (await isRateLimited(ruleId, { key: userId, headers }))
		return {
			limited: true,
			retryAfterSeconds: FIREWALL_RETRY_AFTER_SECONDS,
		};

	return { limited: false };
}

export async function consumeMeetingAudioBudget(
	userId: string,
	samples: number,
	headers: Headers,
): Promise<MeetingBudgetResult> {
	const ruleId = RATE_LIMIT_IDS.MEETINGS_AUDIO;
	const units = meetingAudioUnits(samples);
	const firewall = await checkFirewallRateLimitUnits(ruleId, {
		key: userId,
		units,
		headers,
	});
	if (firewall === true)
		return {
			limited: true,
			retryAfterSeconds: AUDIO_FIREWALL_RETRY_AFTER_SECONDS,
		};
	if (firewall === false) return { limited: false };

	const decision = await consumeRollingBudget(ruleId, {
		key: userId,
		rule: MEETING_AUDIO_BUDGET,
		cost: units,
	});
	return decision.allowed
		? { limited: false }
		: { limited: true, retryAfterSeconds: decision.retryAfterSeconds };
}
