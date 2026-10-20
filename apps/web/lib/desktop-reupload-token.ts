import {
	createHash,
	createHmac,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import { serverEnv } from "@cap/env";
import { Video } from "@cap/web-domain";
import { Option, Schema } from "effect";
import { z } from "zod";

const TOKEN_PREFIX = "cap-reupload.";
const SIGNING_DOMAIN = "cap-desktop-reupload:v1:";
const TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_TOKEN_LENGTH = 32_768;
const identifier = z
	.string()
	.min(1)
	.max(255)
	.regex(/^[A-Za-z0-9_-]+$/);
const tokenSchema = z
	.object({
		version: z.literal(1),
		ownerId: identifier,
		videoId: identifier,
		bucketId: z.string().min(1).max(255).nullable(),
		storageIntegrationId: z.string().min(1).max(255).nullable(),
		provider: z.enum(["s3", "googleDrive"]),
		uploadId: z.string().min(1).max(8192),
		outputKey: z.string().min(1).max(1024),
		sourceIdentity: z.string().regex(/^[a-f0-9]{64}$/),
		expiresAt: z.number().int().safe(),
	})
	.strict();

export type DesktopReuploadToken = z.infer<typeof tokenSchema>;
export type DesktopReuploadVideo = Pick<
	Video.Video,
	"id" | "ownerId" | "bucketId" | "storageIntegrationId" | "source"
>;

const decodeSource = Schema.decodeUnknownSync(Video.Video.fields.source);

export function desktopReuploadSourceIdentity(source: unknown): string {
	let normalized: Video.Video["source"];
	try {
		normalized = decodeSource(source);
	} catch {
		throw new Error("Invalid recording source");
	}
	return createHash("sha256")
		.update(JSON.stringify(normalized, Object.keys(normalized).sort()))
		.digest("hex");
}

function hasValidOutputKey(token: DesktopReuploadToken): boolean {
	const prefix = `${token.ownerId}/${token.videoId}/.recording/outputs/reupload-`;
	return (
		token.outputKey.startsWith(prefix) &&
		/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/result\.mp4$/.test(
			token.outputKey.slice(prefix.length),
		)
	);
}

function parseToken(value: unknown): DesktopReuploadToken {
	const parsed = tokenSchema.safeParse(value);
	const now = Date.now();
	if (
		!parsed.success ||
		parsed.data.expiresAt <= now ||
		parsed.data.expiresAt > now + TOKEN_LIFETIME_MS + MAX_CLOCK_SKEW_MS ||
		!hasValidOutputKey(parsed.data)
	) {
		throw new Error("Invalid desktop reupload token");
	}
	return parsed.data;
}

function signature(payload: string): Buffer {
	const secret = serverEnv().NEXTAUTH_SECRET;
	if (!secret) throw new Error("Desktop reupload signing is unavailable");
	return createHmac("sha256", secret)
		.update(SIGNING_DOMAIN)
		.update(payload)
		.digest();
}

export function createDesktopReuploadKey(
	video: Pick<DesktopReuploadVideo, "id" | "ownerId">,
): string {
	if (
		!identifier.safeParse(video.id).success ||
		!identifier.safeParse(video.ownerId).success
	) {
		throw new Error("Invalid desktop reupload target");
	}
	return `${video.ownerId}/${video.id}/.recording/outputs/reupload-${randomUUID()}/result.mp4`;
}

export function createDesktopReuploadToken(
	video: DesktopReuploadVideo,
	upload: Pick<DesktopReuploadToken, "uploadId" | "provider" | "outputKey">,
): string {
	const token = parseToken({
		version: 1,
		ownerId: video.ownerId,
		videoId: video.id,
		bucketId: Option.getOrNull(video.bucketId),
		storageIntegrationId: Option.getOrNull(video.storageIntegrationId),
		provider: upload.provider,
		uploadId: upload.uploadId,
		outputKey: upload.outputKey,
		sourceIdentity: desktopReuploadSourceIdentity(video.source),
		expiresAt: Date.now() + TOKEN_LIFETIME_MS,
	});
	const payload = Buffer.from(JSON.stringify(token)).toString("base64url");
	const encoded = `${TOKEN_PREFIX}${payload}.${signature(payload).toString("base64url")}`;
	if (encoded.length > MAX_TOKEN_LENGTH) {
		throw new Error("Invalid desktop reupload token");
	}
	return encoded;
}

export function decodeDesktopReuploadToken(
	encoded: string,
): DesktopReuploadToken | null {
	if (!encoded.startsWith(TOKEN_PREFIX)) return null;
	if (encoded.length > MAX_TOKEN_LENGTH) {
		throw new Error("Invalid desktop reupload token");
	}
	const parts = encoded.slice(TOKEN_PREFIX.length).split(".");
	const [payload, signed] = parts;
	if (
		parts.length !== 2 ||
		!payload ||
		!signed ||
		!/^[A-Za-z0-9_-]+$/.test(payload) ||
		!/^[A-Za-z0-9_-]{43}$/.test(signed)
	) {
		throw new Error("Invalid desktop reupload token");
	}
	const bytes = Buffer.from(payload, "base64url");
	const suppliedSignature = Buffer.from(signed, "base64url");
	if (
		bytes.toString("base64url") !== payload ||
		suppliedSignature.toString("base64url") !== signed ||
		!timingSafeEqual(signature(payload), suppliedSignature)
	) {
		throw new Error("Invalid desktop reupload token");
	}
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error("Invalid desktop reupload token");
	}
	return parseToken(value);
}

export function assertDesktopReuploadTarget(
	token: DesktopReuploadToken,
	video: DesktopReuploadVideo,
	requestedCanonicalKey: string,
	provider?: DesktopReuploadToken["provider"],
): void {
	parseToken(token);
	if (
		token.ownerId !== video.ownerId ||
		token.videoId !== video.id ||
		requestedCanonicalKey !== `${video.ownerId}/${video.id}/result.mp4`
	) {
		throw new Error("Recording target changed during reupload");
	}
	if (
		token.bucketId !== Option.getOrNull(video.bucketId) ||
		token.storageIntegrationId !==
			Option.getOrNull(video.storageIntegrationId) ||
		(provider !== undefined && token.provider !== provider)
	) {
		throw new Error("Recording storage changed during reupload");
	}
	if (
		(video.source.type === "desktopMP4" || video.source.type === "webMP4") &&
		video.source.outputKey === token.outputKey
	) {
		return;
	}
	if (desktopReuploadSourceIdentity(video.source) !== token.sourceIdentity) {
		throw new Error("Recording source changed during reupload");
	}
}
