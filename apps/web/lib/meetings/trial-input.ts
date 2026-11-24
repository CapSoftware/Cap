// A free meeting's request reaches a model with at most this many bytes, so
// every free run has a small, fixed ceiling. A two hour meeting's transcript
// fits with room to spare; a longer one is cut at the end and its notes say
// the transcript is incomplete.
export const MEETING_TRIAL_INPUT_MAX_BYTES = 256_000;

export type TrialFit<T> = { input: T; truncated: boolean } | null;

function utf8Prefix(text: string, maxBytes: number): string {
	const encoded = new TextEncoder().encodeInto(text, new Uint8Array(maxBytes));
	const prefix = text.slice(0, encoded.read);
	const lineEnd = prefix.lastIndexOf("\n");
	return lineEnd > 0 ? prefix.slice(0, lineEnd) : prefix;
}

// `inputBytes` is the request body as sent. Only the transcript is cut: when
// the rest of the request alone is over the limit, it is refused (null).
export function fitTrialInput<T extends { transcript: string }>(
	input: T,
	inputBytes: number,
	maxBytes = MEETING_TRIAL_INPUT_MAX_BYTES,
): TrialFit<T> {
	if (inputBytes <= maxBytes) return { input, truncated: false };
	const transcriptBytes = Buffer.byteLength(JSON.stringify(input.transcript));
	const budget = maxBytes - (inputBytes - transcriptBytes);
	if (budget <= 0) return null;
	const transcript = utf8Prefix(input.transcript, budget);
	if (!transcript.trim()) return null;
	return { input: { ...input, transcript }, truncated: true };
}
