import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_VERSION = "v0";
const DEFAULT_TOLERANCE_SECONDS = 60 * 5;

export const createSlackSignature = ({
	body,
	timestamp,
	signingSecret,
}: {
	body: string;
	timestamp: string;
	signingSecret: string;
}) =>
	`${SIGNATURE_VERSION}=${createHmac("sha256", signingSecret)
		.update(`${SIGNATURE_VERSION}:${timestamp}:${body}`)
		.digest("hex")}`;

export const verifySlackSignature = ({
	body,
	timestamp,
	signature,
	signingSecret,
	now = Date.now(),
	toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
}: {
	body: string;
	timestamp: string | undefined;
	signature: string | undefined;
	signingSecret: string;
	now?: number;
	toleranceSeconds?: number;
}) => {
	if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
	const requestTime = Number(timestamp);
	if (!Number.isSafeInteger(requestTime)) return false;
	if (Math.abs(Math.floor(now / 1000) - requestTime) > toleranceSeconds) {
		return false;
	}

	const expected = createSlackSignature({ body, timestamp, signingSecret });
	const expectedBuffer = Buffer.from(expected);
	const signatureBuffer = Buffer.from(signature);
	if (expectedBuffer.length !== signatureBuffer.length) return false;
	return timingSafeEqual(expectedBuffer, signatureBuffer);
};
