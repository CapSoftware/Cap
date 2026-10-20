import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const PREFLIGHT_POLICY = "ownership-preflight-v1";
export const PREFLIGHT_MAX_BYTES = 64 * 1024 ** 3;
export const PREFLIGHT_MAX_TOKEN = 8 * 1024 ** 2;
export const PREFLIGHT_LIFETIME_MS = 24 * 60 * 60_000;
export const PREFLIGHT_CHUNK_BYTES = 8 * 1024 ** 2;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().safe();
const positive = z.number().finite().positive();
const identity = z
	.string()
	.max(1024)
	.regex(/^"[\x21\x23-\x7E\x80-\xFF]+"$/);
const objectKey = z
	.string()
	.min(1)
	.max(1024)
	.refine(
		(value) =>
			!value.includes("\\") &&
			!value.includes("%") &&
			!Array.from(value).some(
				(character) =>
					character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
			) &&
			value.split("/").every((part) => part && part !== "." && part !== ".."),
	);

export class OwnershipPreflightError extends Error {
	constructor(
		readonly code:
			| "INVALID_EVIDENCE"
			| "EXPIRED"
			| "CHANGED"
			| "LIMIT"
			| "INTERRUPTED"
			| "MEDIA_INVALID"
			| "BUSY"
			| "UNAVAILABLE",
	) {
		super(`Ownership preflight held: ${code}`);
	}
}

export const preflightHeadSchema = z
	.object({
		key: objectKey,
		size: integer.min(1).max(PREFLIGHT_MAX_BYTES),
		identity,
		versionId: z.string().min(1).max(1024).nullable(),
		contentType: z.string().min(1).max(128),
		metadataHash: digest,
		copyMetadataHash: digest,
	})
	.strict();
export type PreflightHead = z.infer<typeof preflightHeadSchema>;
const httpsUrl = z
	.string()
	.max(8192)
	.url()
	.refine((value) => {
		const url = new URL(value);
		return (
			url.protocol === "https:" && !url.username && !url.password && !url.hash
		);
	});
export const preflightRequestSchema = z
	.object({
		policy: z.literal(PREFLIGHT_POLICY),
		context: digest,
		issuedAt: integer,
		expiresAt: integer,
		manifest: z.array(preflightHeadSchema).min(1).max(10_000),
		reads: z
			.array(
				z
					.object({ ref: digest, pinnedUrl: httpsUrl, currentUrl: httpsUrl })
					.strict(),
			)
			.min(1)
			.max(10_000),
		assets: z
			.array(
				z
					.object({
						ref: digest,
						expectedDuration: positive.nullable(),
						requiredAudio: z.boolean().optional(),
					})
					.strict(),
			)
			.min(1)
			.max(10_000),
		base: digest,
		selected: digest,
	})
	.strict();
export type PreflightRequest = z.infer<typeof preflightRequestSchema>;

const stream = z
	.object({
		contentSha256: digest,
		timelineSha256: digest,
		format: z.string().max(1024),
	})
	.strict();
export const preflightDecodeSchema = z
	.object({
		fullDecode: z.literal(true),
		video: z
			.object({
				frameCount: integer.min(1),
				startTime: z.number().finite(),
				endTime: z.number().finite(),
				duration: positive,
			})
			.strict(),
		audio: z
			.object({
				frameCount: integer.min(1),
				startTime: z.number().finite(),
				endTime: z.number().finite(),
				duration: positive,
				sampleCount: integer.min(1),
				sampleRate: integer.min(1),
				decodedDuration: positive,
			})
			.strict()
			.nullable(),
		integrity: z.object({ video: stream, audio: stream.nullable() }).strict(),
	})
	.strict();
export type PreflightDecode = z.infer<typeof preflightDecodeSchema>;
export const preflightReceiptSchema = z
	.object({
		policy: z.literal(PREFLIGHT_POLICY),
		context: digest,
		manifestHash: digest,
		requestHash: digest,
		issuedAt: integer,
		expiresAt: integer,
		objects: z
			.array(z.object({ ref: digest, sha256: digest }).strict())
			.min(1)
			.max(10_000),
		assets: z
			.array(z.object({ ref: digest, decode: preflightDecodeSchema }).strict())
			.min(1)
			.max(10_000),
	})
	.strict();
export type PreflightReceipt = z.infer<typeof preflightReceiptSchema>;

function canonical(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entry]) => entry !== undefined)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	return value;
}

export function preflightHash(value: unknown) {
	return createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex");
}

export function preflightRequestHash(
	request: Pick<
		PreflightRequest,
		"context" | "manifest" | "assets" | "base" | "selected"
	>,
) {
	return preflightHash({
		policy: PREFLIGHT_POLICY,
		context: request.context,
		manifest: request.manifest,
		assets: request.assets,
		base: request.base,
		selected: request.selected,
	});
}

export function sealPreflight(
	kind: "request" | "receipt" | "checkpoint",
	value: unknown,
	secret: string,
) {
	if (secret.length < 32) throw new OwnershipPreflightError("UNAVAILABLE");
	const body = Buffer.from(JSON.stringify(value)).toString("base64url");
	const signature = createHmac("sha256", secret)
		.update(`${PREFLIGHT_POLICY}:${kind}:${body}`)
		.digest("hex");
	const token = `${body}.${signature}`;
	if (token.length > PREFLIGHT_MAX_TOKEN)
		throw new OwnershipPreflightError("LIMIT");
	return token;
}

export function openPreflight<T>(
	kind: "request" | "receipt" | "checkpoint",
	token: string,
	secret: string,
	schema: z.ZodType<T>,
): T {
	if (secret.length < 32 || token.length > PREFLIGHT_MAX_TOKEN)
		throw new OwnershipPreflightError("INVALID_EVIDENCE");
	const [body, signature, extra] = token.split(".");
	if (!body || !signature || extra || !/^[a-f0-9]{64}$/.test(signature))
		throw new OwnershipPreflightError("INVALID_EVIDENCE");
	const expected = createHmac("sha256", secret)
		.update(`${PREFLIGHT_POLICY}:${kind}:${body}`)
		.digest();
	if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
		throw new OwnershipPreflightError("INVALID_EVIDENCE");
	try {
		return schema.parse(
			JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
		);
	} catch {
		throw new OwnershipPreflightError("INVALID_EVIDENCE");
	}
}

export function requirePreflightTime(
	value: { issuedAt: number; expiresAt: number },
	now = Date.now(),
) {
	if (
		value.issuedAt > now + 60_000 ||
		value.expiresAt <= now ||
		value.expiresAt <= value.issuedAt ||
		value.expiresAt - value.issuedAt > PREFLIGHT_LIFETIME_MS
	)
		throw new OwnershipPreflightError("EXPIRED");
}

export function requirePreflightRequest(
	request: PreflightRequest,
	now = Date.now(),
) {
	requirePreflightTime(request, now);
	const refs = request.manifest.map((object) => preflightHash(object.key));
	const unique = (values: string[]) => new Set(values).size === values.length;
	if (
		!unique(refs) ||
		!unique(request.assets.map((asset) => asset.ref)) ||
		!unique(request.reads.map((read) => read.ref)) ||
		request.reads.length !== refs.length ||
		request.reads.some((read) => !refs.includes(read.ref)) ||
		request.assets.some((asset) => !refs.includes(asset.ref)) ||
		!request.assets.some((asset) => asset.ref === request.base) ||
		!request.assets.some((asset) => asset.ref === request.selected) ||
		request.manifest.reduce((sum, object) => sum + object.size, 0) >
			PREFLIGHT_MAX_BYTES
	)
		throw new OwnershipPreflightError("INVALID_EVIDENCE");
}

export function requirePreflightReceipt(
	receipt: PreflightReceipt,
	request: Pick<
		PreflightRequest,
		"context" | "manifest" | "assets" | "base" | "selected"
	>,
	now = Date.now(),
) {
	requirePreflightTime(receipt, now);
	if (
		receipt.context !== request.context ||
		receipt.manifestHash !== preflightHash(request.manifest) ||
		receipt.requestHash !== preflightRequestHash(request) ||
		receipt.objects.length !== request.manifest.length ||
		receipt.assets.length !== request.assets.length ||
		new Set(receipt.objects.map((object) => object.ref)).size !==
			receipt.objects.length ||
		new Set(receipt.assets.map((asset) => asset.ref)).size !==
			receipt.assets.length ||
		request.manifest.some(
			(object) =>
				!receipt.objects.some(
					(verified) => verified.ref === preflightHash(object.key),
				),
		) ||
		request.assets.some(
			(asset) => !receipt.assets.some((verified) => verified.ref === asset.ref),
		)
	)
		throw new OwnershipPreflightError("INVALID_EVIDENCE");
	for (const asset of receipt.assets) {
		const { video, audio, integrity } = asset.decode;
		const expected = request.assets.find(
			(item) => item.ref === asset.ref,
		)?.expectedDuration;
		const tolerance = Math.min(0.5, video.duration * 0.1);
		if (
			video.endTime <= video.startTime ||
			Math.abs(video.endTime - video.startTime - video.duration) > 0.001 ||
			(expected &&
				Math.abs(video.duration - expected) >
					Math.max(0.5, Math.min(5, expected * 0.01))) ||
			Boolean(audio) !== Boolean(integrity.audio) ||
			(request.assets.find((item) => item.ref === asset.ref)?.requiredAudio ===
				true &&
				!audio) ||
			(audio &&
				(audio.startTime > video.startTime + tolerance ||
					audio.endTime < video.endTime - tolerance ||
					audio.decodedDuration < video.duration - tolerance))
		)
			throw new OwnershipPreflightError("MEDIA_INVALID");
	}
	const base = receipt.assets.find(
		(asset) => asset.ref === request.base,
	)?.decode;
	const selected = receipt.assets.find(
		(asset) => asset.ref === request.selected,
	)?.decode;
	if (
		!base ||
		!selected ||
		(request.base !== request.selected &&
			(!base.audio ||
				!selected.audio ||
				preflightHash(base.video) !== preflightHash(selected.video) ||
				preflightHash(base.integrity.video) !==
					preflightHash(selected.integrity.video)))
	)
		throw new OwnershipPreflightError("MEDIA_INVALID");
}
