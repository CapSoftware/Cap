import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PreverifiedVideoRun } from "./recording-verification";

const sourceSchema = z.object({
	objectIdentity: z.string().min(1).max(200),
	size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const payloadSchema = z.object({
	version: z.literal(1),
	init: sourceSchema,
	segments: z.array(sourceSchema).min(1).max(4_096),
	lines: z.array(z.string().max(16_384)).min(1).max(1_000_000),
});
const signedSchema = payloadSchema.extend({
	signature: z.string().regex(/^[a-f0-9]{64}$/),
});

export type PreverifiedSource = z.infer<typeof sourceSchema>;
export type PreverifiedRunPayload = z.infer<typeof payloadSchema>;

export const MAX_PREVERIFIED_RUN_BYTES = 64 * 1024 * 1024;

function sign(payload: PreverifiedRunPayload, secret: string) {
	return createHmac("sha256", secret)
		.update(
			JSON.stringify([
				payload.version,
				payload.init,
				payload.segments,
				payload.lines,
			]),
		)
		.digest("hex");
}

export function signPreverifiedRun(
	payload: PreverifiedRunPayload,
	secret: string,
): string {
	return JSON.stringify({ ...payload, signature: sign(payload, secret) });
}

// Only this fleet holds the secret, so a run that verifies was decoded by a media server from the exact
// fragments it names; anything else is ignored and those fragments are decoded again.
export function readPreverifiedRun(
	text: string,
	secret: string,
): PreverifiedRunPayload | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	const parsed = signedSchema.safeParse(value);
	if (!parsed.success) return null;
	const { signature, ...payload } = parsed.data;
	const expected = Buffer.from(sign(payload, secret), "hex");
	const actual = Buffer.from(signature, "hex");
	return expected.length === actual.length && timingSafeEqual(expected, actual)
		? payload
		: null;
}

const sameSource = (left: PreverifiedSource, right: PreverifiedSource) =>
	left.objectIdentity === right.objectIdentity && left.size === right.size;

// Chains runs that cover the recording's fragments from the first one, in order and by content identity;
// the chain stops at the first fragment no run starts at.
export function resolvePreverifiedRuns(
	runs: PreverifiedRunPayload[],
	init: PreverifiedSource,
	segments: PreverifiedSource[],
): PreverifiedVideoRun[] {
	const resolved: PreverifiedVideoRun[] = [];
	const candidates = runs.filter((run) => sameSource(run.init, init));
	let position = 0;
	while (position < segments.length) {
		const next = candidates
			.filter(
				(run) =>
					position + run.segments.length <= segments.length &&
					run.segments.every((source, offset) => {
						const expected = segments[position + offset];
						return expected !== undefined && sameSource(source, expected);
					}),
			)
			.sort((left, right) => right.segments.length - left.segments.length)[0];
		if (!next) break;
		resolved.push({ segments: next.segments.length, lines: next.lines });
		position += next.segments.length;
	}
	return resolved;
}

// Reads at most `limit` bytes, whatever the response claims about its length.
export async function readBoundedText(
	response: Response,
	limit: number,
): Promise<string | null> {
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit) {
				await reader.cancel().catch(() => {});
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}
