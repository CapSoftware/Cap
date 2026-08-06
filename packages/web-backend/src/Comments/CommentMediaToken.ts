import { createHmac, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@cap/env";

export type CommentMediaUploadClaims = {
	userId: string;
	videoId: string;
	commentId: string;
	key: string;
	thumbnailKey: string | null;
	contentType: string;
	kind: "video" | "audio";
	expiresAt: number;
};

// Domain separator so an upload capability can never be replayed as a
// storage-object read token (or vice versa) — both are HMACs under
// NEXTAUTH_SECRET.
const DOMAIN = "comment-media:";

const encode = (value: unknown) =>
	Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const sign = (payload: string) =>
	createHmac("sha256", serverEnv().NEXTAUTH_SECRET)
		.update(DOMAIN + payload)
		.digest("base64url");

export function createCommentMediaUploadToken(
	claims: Omit<CommentMediaUploadClaims, "expiresAt">,
	ttlSeconds = 6 * 60 * 60,
) {
	const encodedPayload = encode({
		...claims,
		expiresAt: Date.now() + ttlSeconds * 1000,
	});
	return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyCommentMediaUploadToken(
	token: string,
): CommentMediaUploadClaims | null {
	const [encodedPayload, signature] = token.split(".");
	if (!encodedPayload || !signature) return null;

	const expected = sign(encodedPayload);
	const signatureBuffer = Buffer.from(signature);
	const expectedBuffer = Buffer.from(expected);
	if (signatureBuffer.length !== expectedBuffer.length) return null;
	if (!timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

	let claims: CommentMediaUploadClaims;
	try {
		claims = JSON.parse(
			Buffer.from(encodedPayload, "base64url").toString("utf8"),
		) as CommentMediaUploadClaims;
	} catch {
		return null;
	}

	if (
		typeof claims.userId !== "string" ||
		typeof claims.videoId !== "string" ||
		typeof claims.commentId !== "string" ||
		typeof claims.key !== "string" ||
		typeof claims.contentType !== "string" ||
		(claims.kind !== "video" && claims.kind !== "audio") ||
		typeof claims.expiresAt !== "number"
	)
		return null;

	if (claims.expiresAt < Date.now()) return null;
	return claims;
}
