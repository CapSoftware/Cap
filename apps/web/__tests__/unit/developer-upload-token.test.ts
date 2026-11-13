import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ secret: "unit-test-signing-secret" }));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ NEXTAUTH_SECRET: env.secret }),
}));

import {
	createDeveloperUploadToken,
	isDeveloperPublicKey,
	missingUploadTokenRefusal,
	publicKeyRefusal,
	uploadTokenRefusal,
	verifyDeveloperUploadToken,
} from "@/lib/developer-upload-token";

const NOW = Date.parse("2026-11-12T10:00:00Z");
const fields = {
	appId: "app-1",
	videoId: "video-1",
	expiresAt: NOW + 3_600_000,
	corsOrigin: "https://app.example.com",
};

const encode = (value: unknown) =>
	Buffer.from(JSON.stringify(value)).toString("base64url");
const parts = (token: string) => {
	const [payload = "", signature = ""] = token.slice(4).split(".");
	return { payload, signature };
};

beforeEach(() => {
	env.secret = "unit-test-signing-secret";
});

describe("upload token", () => {
	it("carries the app, video, expiry and origin it was made for", () => {
		const token = createDeveloperUploadToken(fields);

		expect(token.startsWith("cut_")).toBe(true);
		expect(verifyDeveloperUploadToken(token, NOW)).toEqual({
			ok: true,
			token: fields,
		});
	});

	it("carries no origin when none was set", () => {
		const token = createDeveloperUploadToken({ ...fields, corsOrigin: null });

		expect(verifyDeveloperUploadToken(token, NOW)).toMatchObject({
			ok: true,
			token: { corsOrigin: null },
		});
	});

	it("expires at expiresAt and not a millisecond before", () => {
		const token = createDeveloperUploadToken(fields);

		expect(verifyDeveloperUploadToken(token, fields.expiresAt - 1).ok).toBe(
			true,
		);
		expect(verifyDeveloperUploadToken(token, fields.expiresAt)).toEqual({
			ok: false,
			reason: "expired",
		});
	});

	it.each([
		["another video", { video: "video-2" }],
		["another app", { app: "app-2" }],
		["a later expiry", { exp: NOW + 86_400_000 }],
		["another origin", { origin: "https://attacker.example" }],
		["no origin", { origin: null }],
	])(
		"refuses a payload rewritten for %s under the old signature",
		(_label, change) => {
			const token = createDeveloperUploadToken(fields);
			const { signature } = parts(token);
			const payload = encode({
				v: 1,
				app: fields.appId,
				video: fields.videoId,
				exp: fields.expiresAt,
				origin: fields.corsOrigin,
				...change,
			});

			expect(
				verifyDeveloperUploadToken(`cut_${payload}.${signature}`, NOW),
			).toEqual({ ok: false, reason: "invalid" });
		},
	);

	it.each([
		[
			"a flipped signature character",
			(token: string) => {
				const last = token.at(-1) === "A" ? "B" : "A";
				return `${token.slice(0, -1)}${last}`;
			},
		],
		["a truncated signature", (token: string) => token.slice(0, -4)],
		["no signature", (token: string) => `cut_${parts(token).payload}`],
		["an empty signature", (token: string) => `cut_${parts(token).payload}.`],
		["a third segment", (token: string) => `${token}.extra`],
		["another prefix", (token: string) => `cpk_${token.slice(4)}`],
		["padding added to the signature", (token: string) => `${token}=`],
		["only the prefix", () => "cut_"],
		[
			"a token longer than the limit",
			(token: string) => `${token}${"A".repeat(4096)}`,
		],
	])("refuses %s", (_label, alter) => {
		const token = createDeveloperUploadToken(fields);

		expect(verifyDeveloperUploadToken(alter(token), NOW)).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	it("refuses a token signed with another secret", () => {
		const token = createDeveloperUploadToken(fields);
		env.secret = "a-different-secret";

		expect(verifyDeveloperUploadToken(token, NOW)).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	it("does not accept the server secret itself as the signing key", async () => {
		const { createHmac } = await import("node:crypto");
		const payload = encode({
			v: 1,
			app: fields.appId,
			video: fields.videoId,
			exp: fields.expiresAt,
			origin: null,
		});
		const signature = createHmac("sha256", env.secret)
			.update(payload)
			.digest("base64url");

		expect(
			verifyDeveloperUploadToken(`cut_${payload}.${signature}`, NOW),
		).toEqual({ ok: false, reason: "invalid" });
	});

	it("reports an expired token as invalid when it was also altered", () => {
		const token = createDeveloperUploadToken({
			...fields,
			expiresAt: NOW - 1,
		});

		expect(verifyDeveloperUploadToken(token, NOW).ok).toBe(false);
		expect(
			verifyDeveloperUploadToken(`${token.slice(0, -1)}_`, NOW),
		).toMatchObject({ reason: "invalid" });
	});
});

describe("upload token size cap", () => {
	const issuedBeforeTheCap =
		"cut_eyJ2IjoxLCJhcHAiOiJhcHAtMSIsInZpZGVvIjoidmlkZW8tMSIsImV4cCI6MTc5NDQ4MTIwMDAwMCwib3JpZ2luIjoiaHR0cHM6Ly9hcHAuZXhhbXBsZS5jb20ifQ.vxfWYfqpiizehUCsXA4N2lvp8X_PeXKgMWrk8QO3Si4";

	it("still verifies a token issued before the cap existed", () => {
		expect(verifyDeveloperUploadToken(issuedBeforeTheCap, NOW)).toEqual({
			ok: true,
			token: fields,
		});
	});

	it("issues the same token as before when no cap is set", () => {
		expect(createDeveloperUploadToken(fields)).toBe(issuedBeforeTheCap);
		expect(
			"maxBytes" in
				(
					verifyDeveloperUploadToken(issuedBeforeTheCap, NOW) as {
						token: object;
					}
				).token,
		).toBe(false);
	});

	it("carries the cap it was made with", () => {
		const token = createDeveloperUploadToken({
			...fields,
			maxBytes: 250_000_000,
		});

		expect(token).not.toBe(issuedBeforeTheCap);
		expect(verifyDeveloperUploadToken(token, NOW)).toEqual({
			ok: true,
			token: { ...fields, maxBytes: 250_000_000 },
		});
	});

	it.each([
		["a larger cap", { max: 500_000_000 }],
		["no cap", {}],
	])(
		"refuses a capped payload rewritten for %s under the old signature",
		(_label, change) => {
			const token = createDeveloperUploadToken({
				...fields,
				maxBytes: 250_000_000,
			});
			const payload = encode({
				v: 1,
				app: fields.appId,
				video: fields.videoId,
				exp: fields.expiresAt,
				origin: fields.corsOrigin,
				...change,
			});

			expect(
				verifyDeveloperUploadToken(
					`cut_${payload}.${parts(token).signature}`,
					NOW,
				),
			).toEqual({ ok: false, reason: "invalid" });
		},
	);

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"does not issue a token with the cap %s",
		(maxBytes) => {
			expect(() =>
				createDeveloperUploadToken({ ...fields, maxBytes }),
			).toThrow();
		},
	);
});

describe("an expired upload token", () => {
	it("points at the route that renews it", () => {
		expect(uploadTokenRefusal("expired")).toMatchObject({
			code: "upload_token_expired",
			hint: expect.stringContaining(
				"POST /api/developer/v1/uploads/{videoId}/token",
			),
		});
	});
});

describe("what was sent instead of an upload token", () => {
	it("recognises a public key", () => {
		expect(isDeveloperPublicKey("cpk_abc")).toBe(true);
		expect(isDeveloperPublicKey("csk_abc")).toBe(false);
		expect(isDeveloperPublicKey("cut_abc")).toBe(false);
		expect(isDeveloperPublicKey(undefined)).toBe(false);
	});

	it("points a public key at the route that makes tokens", () => {
		expect(publicKeyRefusal()).toMatchObject({
			code: "public_key_not_allowed",
			hint: expect.stringContaining("POST /api/developer/v1/uploads"),
		});
	});

	it.each([
		["csk_abc", /secret key/i],
		["something-else", /not an upload token/],
		[undefined, /No upload token/],
	])("says what %s is", (credential, message) => {
		const refusal = missingUploadTokenRefusal(credential);

		expect(refusal.code).toBe("invalid_upload_token");
		expect(refusal.message).toMatch(message);
		expect(refusal.hint).toContain("POST /api/developer/v1/uploads");
	});
});
