import {
	SPEECH_MICRO_CREDITS_PER_HOUR,
	transcriptionMicroCredits,
} from "@/lib/developer-pricing";
import {
	TRANSCRIPT_DURATION_SLACK_SECONDS,
	TRANSCRIPT_MAX_DURATION_SECONDS,
	TRANSCRIPT_MIN_START_BALANCE_MICRO_CREDITS,
} from "@/lib/developer-transcripts";

const HOLD_FLOOR_BYTES_PER_SECOND = 500;
const HOLD_SECONDS_MARGIN = 2;

export const TRANSCRIPT_FULL_HOLD_MICRO_CREDITS = transcriptionMicroCredits(
	TRANSCRIPT_MAX_DURATION_SECONDS,
);

const TRANSCRIPT_FULL_HOLD_SECONDS =
	TRANSCRIPT_MAX_DURATION_SECONDS + TRANSCRIPT_DURATION_SLACK_SECONDS;

const dollarsUp = (microCredits: number) =>
	`$${(Math.ceil(Math.max(0, microCredits) / 1000) / 100).toFixed(2)}`;

const dollarsDown = (microCredits: number) =>
	`$${(Math.floor(Math.max(0, microCredits) / 1000) / 100).toFixed(2)}`;

const holdForSeconds = (seconds: number) =>
	Math.min(
		TRANSCRIPT_FULL_HOLD_MICRO_CREDITS,
		Math.max(
			TRANSCRIPT_MIN_START_BALANCE_MICRO_CREDITS,
			transcriptionMicroCredits(seconds),
		),
	);

export function transcriptHoldForSourceBytes(sourceBytes: number | null) {
	return sourceBytes === null
		? TRANSCRIPT_FULL_HOLD_MICRO_CREDITS
		: holdForSeconds(Math.ceil(sourceBytes / HOLD_FLOOR_BYTES_PER_SECOND));
}

export function transcriptHoldForAudioSeconds(seconds: number | null) {
	return seconds === null
		? TRANSCRIPT_FULL_HOLD_MICRO_CREDITS
		: holdForSeconds(Math.ceil(seconds) + HOLD_SECONDS_MARGIN);
}

export function transcriptHoldCoversSeconds(microCredits: number) {
	if (microCredits >= TRANSCRIPT_FULL_HOLD_MICRO_CREDITS) {
		return TRANSCRIPT_FULL_HOLD_SECONDS;
	}
	return Math.floor(
		(Math.max(0, microCredits) * 3600) / SPEECH_MICRO_CREDITS_PER_HOUR,
	);
}

export function insufficientHoldMessage(
	neededMicroCredits: number,
	availableMicroCredits: number,
) {
	return `This transcript needs ${dollarsUp(neededMicroCredits)} of available credit until its audio is measured, and ${dollarsDown(availableMicroCredits)} is available. Add at least ${dollarsUp(neededMicroCredits - availableMicroCredits)}. Nothing was charged.`;
}
