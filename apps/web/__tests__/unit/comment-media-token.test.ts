import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ NEXTAUTH_SECRET: "test-secret" }),
}));

import {
	createCommentMediaUploadToken,
	verifyCommentMediaUploadToken,
} from "../../../../packages/web-backend/src/Comments/CommentMediaToken";
import { createStorageObjectToken } from "../../../../packages/web-backend/src/Storage/SignedObject";

const claims = {
	userId: "user-1",
	videoId: "video-1",
	commentId: "comment-1",
	key: "owner-1/video-1/comments/comment-1/media.mp4",
	thumbnailKey: "owner-1/video-1/comments/comment-1/thumbnail.jpg",
	contentType: "video/mp4",
	kind: "video" as const,
};

describe("comment media upload token", () => {
	it("round-trips claims", () => {
		const token = createCommentMediaUploadToken(claims);
		const verified = verifyCommentMediaUploadToken(token);
		expect(verified).toMatchObject(claims);
		expect(verified?.expiresAt).toBeGreaterThan(Date.now());
	});

	it("rejects a tampered payload", () => {
		const token = createCommentMediaUploadToken(claims);
		const [payload, signature] = token.split(".");
		const decoded = JSON.parse(
			Buffer.from(payload as string, "base64url").toString("utf8"),
		);
		decoded.key = "owner-1/other-video/comments/comment-1/media.mp4";
		const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;
		expect(verifyCommentMediaUploadToken(forged)).toBeNull();
	});

	it("rejects a tampered signature", () => {
		const token = createCommentMediaUploadToken(claims);
		const [payload, signature] = token.split(".") as [string, string];
		const flipped =
			signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");
		expect(verifyCommentMediaUploadToken(`${payload}.${flipped}`)).toBeNull();
	});

	it("rejects an expired token", () => {
		const token = createCommentMediaUploadToken(claims, -1);
		expect(verifyCommentMediaUploadToken(token)).toBeNull();
	});

	it("rejects garbage and empty input", () => {
		expect(verifyCommentMediaUploadToken("")).toBeNull();
		expect(verifyCommentMediaUploadToken("abc")).toBeNull();
		expect(verifyCommentMediaUploadToken("abc.def")).toBeNull();
	});

	it("rejects a storage-object token (domain separation)", () => {
		// Same secret, same HMAC construction, but a read token must never act
		// as an upload capability.
		const storageToken = createStorageObjectToken({
			videoId: claims.videoId,
			key: claims.key,
		});
		expect(verifyCommentMediaUploadToken(storageToken)).toBeNull();
	});

	it("rejects claims with an invalid kind", () => {
		const token = createCommentMediaUploadToken({
			...claims,
			// biome-ignore lint/suspicious/noExplicitAny: forging an invalid payload on purpose
			kind: "gif" as any,
		});
		expect(verifyCommentMediaUploadToken(token)).toBeNull();
	});
});
