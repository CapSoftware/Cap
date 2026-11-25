import {
	checkFirewallRateLimitUnits,
	consumeRollingBudget,
	getFallbackRateLimit,
	isRateLimited,
	RATE_LIMIT_IDS,
	type RollingBudgetRule,
} from "@/lib/rate-limit";
import { consumeDailyAudioUnits } from "./audio-usage";
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
	| { limited: true; retryAfterSeconds: number; daily?: true };

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

// Notes and Ask send the meeting with every request. On top of the unit paid
// on arrival, a request is charged one more unit per started
// MEETING_BODY_UNIT_BYTES of body past the first, against the same rule. A
// model never reads more tokens than the UTF-8 bytes it is sent.
export const MEETING_BODY_UNIT_BYTES = 100_000;

export function meetingBodyUnits(bytes: number): number {
	return Math.max(1, Math.ceil(bytes / MEETING_BODY_UNIT_BYTES));
}

export async function consumeMeetingBodyBudget(
	endpoint: "notes" | "ask",
	userId: string,
	bodyBytes: number,
	headers: Headers,
): Promise<MeetingBudgetResult> {
	const units = meetingBodyUnits(bodyBytes) - 1;
	if (units < 1) return { limited: false };
	const ruleId = MEETING_REQUEST_RULE_IDS[endpoint];
	const firewall = await checkFirewallRateLimitUnits(ruleId, {
		key: userId,
		units,
		headers,
	});
	if (firewall === true)
		return {
			limited: true,
			retryAfterSeconds: FIREWALL_RETRY_AFTER_SECONDS,
		};
	if (firewall === false) return { limited: false };

	const decision = await consumeRollingBudget(ruleId, {
		key: userId,
		rule: meetingRequestBudget(endpoint),
		cost: units,
	});
	return decision.allowed
		? { limited: false }
		: { limited: true, retryAfterSeconds: decision.retryAfterSeconds };
}

// The firewall keeps the hourly limit and the database the daily one, both
// across instances. When either cannot answer, the per-instance daily window
// stands in.
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

	const daily = await consumeDailyAudioUnits(
		userId,
		units,
		MEETING_AUDIO_BUDGET.limit,
	);
	if (daily.allowed === false)
		return {
			limited: true,
			retryAfterSeconds: daily.retryAfterSeconds,
			daily: true,
		};
	if (firewall === false && daily.allowed) return { limited: false };

	const decision = await consumeRollingBudget(ruleId, {
		key: userId,
		rule: MEETING_AUDIO_BUDGET,
		cost: units,
	});
	return decision.allowed
		? { limited: false }
		: {
				limited: true,
				retryAfterSeconds: decision.retryAfterSeconds,
				daily: true,
			};
}
