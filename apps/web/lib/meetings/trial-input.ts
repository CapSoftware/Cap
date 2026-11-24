// A free meeting's request reaches a model with at most this many bytes, so
// every free run has a small, fixed ceiling. A two hour meeting's transcript
// fits with room to spare. Past it, notes are written from the start of the
// transcript and say it is incomplete, and a question gets the parts most
// related to it.
export const MEETING_TRIAL_INPUT_MAX_BYTES = 256_000;

export type TrialFit<T> = { input: T; truncated: boolean } | null;

function utf8Prefix(text: string, maxBytes: number): string {
	const encoded = new TextEncoder().encodeInto(text, new Uint8Array(maxBytes));
	const prefix = text.slice(0, encoded.read);
	const lineEnd = prefix.lastIndexOf("\n");
	return lineEnd > 0 ? prefix.slice(0, lineEnd) : prefix;
}

// The bytes left for the transcript once the rest of the request (`inputBytes`
// is the body as sent) is counted: undefined when the request is within the
// limit, null when the rest alone is over it.
export function trialTranscriptBudget(
	input: { transcript: string },
	inputBytes: number,
	maxBytes = MEETING_TRIAL_INPUT_MAX_BYTES,
): number | null | undefined {
	if (inputBytes <= maxBytes) return undefined;
	const transcriptBytes = Buffer.byteLength(JSON.stringify(input.transcript));
	const budget = maxBytes - (inputBytes - transcriptBytes);
	return budget > 0 ? budget : null;
}

// Notes read the whole transcript in order, so a long one is cut at the end.
// Only the transcript is cut: a request whose rest alone is over the limit is
// refused (null).
export function fitTrialInput<T extends { transcript: string }>(
	input: T,
	inputBytes: number,
	maxBytes = MEETING_TRIAL_INPUT_MAX_BYTES,
): TrialFit<T> {
	const budget = trialTranscriptBudget(input, inputBytes, maxBytes);
	if (budget === undefined) return { input, truncated: false };
	if (budget === null) return null;
	const transcript = utf8Prefix(input.transcript, budget);
	if (!transcript.trim()) return null;
	return { input: { ...input, transcript }, truncated: true };
}
