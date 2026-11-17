import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

export function verifyWorkosSignature(
	payload: string,
	header: string | null,
	secret: string,
	now = Date.now(),
) {
	if (!header) return false;
	const parts = new Map(
		header.split(",").map((part) => {
			const [key, ...value] = part.trim().split("=");
			return [key, value.join("=")] as const;
		}),
	);
	const timestamp = Number(parts.get("t"));
	const signature = parts.get("v1");
	if (
		!Number.isFinite(timestamp) ||
		!signature ||
		Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_MS
	) {
		return false;
	}
	const expected = createHmac("sha256", secret)
		.update(`${parts.get("t")}.${payload}`)
		.digest("hex");
	const actual = Buffer.from(signature);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
