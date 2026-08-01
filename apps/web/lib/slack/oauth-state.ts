import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const STATE_VERSION = 1;
const STATE_TTL_SECONDS = 60 * 10;
const FUTURE_SKEW_SECONDS = 60;

type SlackOAuthStatePayload = {
	v: typeof STATE_VERSION;
	organizationId: string;
	userId: string;
	issuedAt: number;
	nonce: string;
};

const signState = (payload: string, secret: string) =>
	createHmac("sha256", secret).update(payload).digest("base64url");

export const createSlackOAuthState = ({
	organizationId,
	userId,
	secret,
	now = Date.now(),
	nonce = randomUUID(),
}: {
	organizationId: string;
	userId: string;
	secret: string;
	now?: number;
	nonce?: string;
}) => {
	const encoded = Buffer.from(
		JSON.stringify({
			v: STATE_VERSION,
			organizationId,
			userId,
			issuedAt: Math.floor(now / 1000),
			nonce,
		} satisfies SlackOAuthStatePayload),
	).toString("base64url");
	return `${encoded}.${signState(encoded, secret)}`;
};

const isPayload = (value: unknown): value is SlackOAuthStatePayload => {
	if (!value || typeof value !== "object") return false;
	const payload = value as Partial<SlackOAuthStatePayload>;
	return (
		payload.v === STATE_VERSION &&
		typeof payload.organizationId === "string" &&
		payload.organizationId.length > 0 &&
		payload.organizationId.length <= 128 &&
		typeof payload.userId === "string" &&
		payload.userId.length > 0 &&
		payload.userId.length <= 128 &&
		typeof payload.issuedAt === "number" &&
		Number.isSafeInteger(payload.issuedAt) &&
		typeof payload.nonce === "string" &&
		payload.nonce.length > 0 &&
		payload.nonce.length <= 128
	);
};

export const verifySlackOAuthState = ({
	state,
	secret,
	now = Date.now(),
}: {
	state: string;
	secret: string;
	now?: number;
}): SlackOAuthStatePayload | null => {
	const [encoded, signature, extra] = state.split(".");
	if (!encoded || !signature || extra) return null;
	const expected = signState(encoded, secret);
	const expectedBuffer = Buffer.from(expected);
	const signatureBuffer = Buffer.from(signature);
	if (
		expectedBuffer.length !== signatureBuffer.length ||
		!timingSafeEqual(expectedBuffer, signatureBuffer)
	) {
		return null;
	}

	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	if (!isPayload(payload)) return null;

	const nowSeconds = Math.floor(now / 1000);
	if (
		payload.issuedAt > nowSeconds + FUTURE_SKEW_SECONDS ||
		nowSeconds - payload.issuedAt > STATE_TTL_SECONDS
	) {
		return null;
	}

	return payload;
};
