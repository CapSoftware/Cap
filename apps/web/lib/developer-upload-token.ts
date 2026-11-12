import { createHmac, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@cap/env";
import { z } from "zod";
import { apiErrorBody } from "@/lib/api-errors";

export const UPLOAD_TOKEN_PREFIX = "cut_";
export const UPLOAD_TOKEN_DEFAULT_SECONDS = 60 * 60;
export const UPLOAD_TOKEN_MIN_SECONDS = 60;
export const UPLOAD_TOKEN_MAX_SECONDS = 24 * 60 * 60;
export const CREATE_UPLOAD_PATH = "/api/developer/v1/uploads";
export const RENEW_UPLOAD_TOKEN_PATH = `${CREATE_UPLOAD_PATH}/{videoId}/token`;

const KEY_CONTEXT = "cap-infra-upload-token:v1";
const MAX_TOKEN_LENGTH = 2048;
const SIGNATURE_BYTES = 32;

const payloadSchema = z
	.object({
		v: z.literal(1),
		app: z.string().min(1).max(255),
		video: z.string().min(1).max(255),
		exp: z.number().int().positive().safe(),
		origin: z.string().min(1).max(253).nullable(),
		max: z.number().int().positive().safe().optional(),
	})
	.strict();

export type DeveloperUploadToken = {
	appId: string;
	videoId: string;
	expiresAt: number;
	corsOrigin: string | null;
	maxBytes?: number;
};

export type DeveloperUploadTokenCheck =
	| { ok: true; token: DeveloperUploadToken }
	| { ok: false; reason: "invalid" | "expired" };

function sign(payload: string): Buffer {
	const secret = serverEnv().NEXTAUTH_SECRET;
	if (!secret) throw new Error("Upload token signing is unavailable");
	const key = createHmac("sha256", secret).update(KEY_CONTEXT).digest();
	return createHmac("sha256", key).update(payload).digest();
}

export function createDeveloperUploadToken(token: DeveloperUploadToken) {
	const payload = Buffer.from(
		JSON.stringify(
			payloadSchema.parse({
				v: 1,
				app: token.appId,
				video: token.videoId,
				exp: token.expiresAt,
				origin: token.corsOrigin,
				max: token.maxBytes,
			}),
		),
	).toString("base64url");
	return `${UPLOAD_TOKEN_PREFIX}${payload}.${sign(payload).toString("base64url")}`;
}

const invalid = { ok: false, reason: "invalid" } as const;

export function verifyDeveloperUploadToken(
	encoded: string,
	now: number = Date.now(),
): DeveloperUploadTokenCheck {
	if (
		!encoded.startsWith(UPLOAD_TOKEN_PREFIX) ||
		encoded.length > MAX_TOKEN_LENGTH
	) {
		return invalid;
	}
	const parts = encoded.slice(UPLOAD_TOKEN_PREFIX.length).split(".");
	const [payload, signed] = parts;
	if (parts.length !== 2 || !payload || !signed) return invalid;

	const supplied = Buffer.from(signed, "base64url");
	if (
		supplied.length !== SIGNATURE_BYTES ||
		supplied.toString("base64url") !== signed ||
		!timingSafeEqual(sign(payload), supplied)
	) {
		return invalid;
	}

	let decoded: unknown;
	try {
		decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		return invalid;
	}
	const parsed = payloadSchema.safeParse(decoded);
	if (!parsed.success) return invalid;
	if (parsed.data.exp <= now) return { ok: false, reason: "expired" };

	return {
		ok: true,
		token: {
			appId: parsed.data.app,
			videoId: parsed.data.video,
			expiresAt: parsed.data.exp,
			corsOrigin: parsed.data.origin,
			...(parsed.data.max === undefined ? {} : { maxBytes: parsed.data.max }),
		},
	};
}

const CREATE_UPLOAD_HINT = `Create an upload from your server with POST ${CREATE_UPLOAD_PATH} and your secret key, then send the token it returns as Authorization: Bearer ${UPLOAD_TOKEN_PREFIX}... from the browser.`;

export const publicKeyRefusal = () =>
	apiErrorBody(
		"public_key_not_allowed",
		"Public keys cannot create or upload videos",
		CREATE_UPLOAD_HINT,
	);

export const isDeveloperPublicKey = (credential: string | undefined) =>
	credential?.startsWith("cpk_") ?? false;

export function missingUploadTokenRefusal(credential: string | undefined) {
	const sent = credential?.startsWith("csk_")
		? "A secret key was sent where an upload token is required. Keep secret keys on your server"
		: credential
			? "The credential sent is not an upload token"
			: "No upload token was sent";
	return apiErrorBody("invalid_upload_token", sent, CREATE_UPLOAD_HINT);
}

export const uploadTokenRefusal = (reason: "invalid" | "expired") =>
	reason === "expired"
		? apiErrorBody(
				"upload_token_expired",
				"Upload token has expired",
				`Get a new token for the same video from your server with POST ${RENEW_UPLOAD_TOKEN_PATH}, then continue the upload with it. Set timeoutSeconds, up to ${UPLOAD_TOKEN_MAX_SECONDS}, when an upload needs longer.`,
			)
		: apiErrorBody(
				"invalid_upload_token",
				"Upload token is not valid",
				CREATE_UPLOAD_HINT,
			);
