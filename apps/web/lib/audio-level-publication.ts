import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import {
	videoProcessingJobs,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import { reserveMediaProcessingBudget } from "@/lib/media-processing-budget";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.string().min(1).max(1024);
const sizeSchema = z
	.number()
	.int()
	.positive()
	.max(256 * 1024 * 1024);
const prepareSchema = z.object({
	kind: z.literal("audio-levels"),
	action: z.literal("prepare"),
	videoId: z.string().min(1).max(255),
	userId: z.string().min(1).max(255),
	jobId: z.string().min(1).max(255),
	sourceKey: z.string().min(1).max(1024),
	sourceIdentity: identitySchema,
	sourceSize: sizeSchema,
	duration: z.number().finite().min(3).max(900),
});
const tokenSchema = prepareSchema.extend({
	orgId: z.string().nullable(),
	bucket: z.string().nullable(),
	storageIntegrationId: z.string().nullable(),
	source: z.string(),
	outputKey: z.string(),
	transferBudgetBytes: z.number().int().positive().safe(),
	expiresAt: z.number(),
});
const publishSchema = z.object({
	kind: z.literal("audio-levels"),
	action: z.literal("publish"),
	token: z.string().max(16_384),
	sourceSha256: digestSchema,
	outputSha256: digestSchema,
	outputIdentity: identitySchema,
	outputSize: z
		.number()
		.int()
		.positive()
		.max(512 * 1024 * 1024),
	inputLufs: z.number().finite().min(-55).max(-18),
	outputLufs: z.number().finite().max(-14),
	truePeak: z.number().finite().max(-1),
});

const unchanged = (reason: string) => ({
	status: "unchanged" as const,
	reason,
});

function sign(value: string, secret: string) {
	return createHmac("sha256", secret).update(value).digest("hex");
}

function decodeToken(token: string, secret: string) {
	const [encoded, signature, extra] = token.split(".");
	if (!encoded || !signature || extra || !/^[a-f0-9]{64}$/.test(signature))
		throw new Error("Invalid publication token");
	if (
		!timingSafeEqual(
			Buffer.from(signature, "hex"),
			Buffer.from(sign(encoded, secret), "hex"),
		)
	)
		throw new Error("Invalid publication token");
	const context = tokenSchema.parse(
		JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
	);
	if (context.expiresAt <= Date.now()) throw new Error("Expired publication");
	return context;
}

function originalKey(video: typeof videos.$inferSelect) {
	if (video.source.type === "webMP4")
		return `${video.ownerId}/${video.id}/result.mp4`;
	if (video.source.type === "desktopMP4")
		return Video.getRetainedRecordingOutputKey(
			video.ownerId,
			video.id,
			video.source.outputKey,
		);
}

export async function handleAudioLevelPublication(payload: unknown) {
	try {
		const secret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;
		if (!secret) return unchanged("unavailable");
		const prepare = prepareSchema.safeParse(payload);
		if (prepare.success) {
			const request = prepare.data;
			const id = Video.VideoId.make(request.videoId);
			const [video] = await db().select().from(videos).where(eq(videos.id, id));
			if (
				!video ||
				video.ownerId !== request.userId ||
				originalKey(video) !== request.sourceKey ||
				Video.getAudioLevelOutputKey(video) ||
				!video.duration ||
				!Number.isFinite(video.duration) ||
				video.duration < 3 ||
				video.duration > 900
			)
				return unchanged("ineligible");
			const [upload] = await db()
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, id));
			if (upload) return unchanged("upload-active");
			if (video.source.type === "desktopMP4") {
				const [job] = await db()
					.select()
					.from(videoProcessingJobs)
					.where(eq(videoProcessingJobs.videoId, id));
				if (job?.state !== "verified") return unchanged("unverified");
			}
			const [bucket] = await Storage.getAccessForVideo(
				decodeStorageVideo(video),
				{
					resolvePublishedOutput: false,
				},
			).pipe(runWorkflowPromise);
			if (bucket.provider !== "s3") return unchanged("unsupported-storage");
			const source = await bucket
				.headObject(request.sourceKey)
				.pipe(Effect.timeout("10 seconds"), runWorkflowPromise);
			if (
				source.ETag !== request.sourceIdentity ||
				source.ContentLength !== request.sourceSize
			)
				return unchanged("source-changed");
			const identity = createHash("sha256")
				.update(`${request.sourceKey}:${request.sourceIdentity}`)
				.digest("hex");
			const attempt = createHash("sha256")
				.update(`${identity}:${request.jobId}`)
				.digest("hex");
			const transferBudgetBytes = await reserveMediaProcessingBudget({
				videoId: video.id,
				generation: `audio-${identity}`,
				attemptId: attempt,
				sourceBytes: request.sourceSize,
			});
			const outputKey = `${video.ownerId}/${video.id}/.recording/outputs/audio-quality-v3/${attempt}.mp4`;
			const [outputUrl, verificationUrl] = await Promise.all([
				bucket
					.getInternalPresignedPutUrl(
						outputKey,
						{ ContentType: "video/mp4", IfNoneMatch: "*" },
						{ expiresIn: 600 },
					)
					.pipe(runWorkflowPromise),
				bucket
					.getInternalSignedObjectUrl(outputKey, { expiresIn: 600 })
					.pipe(runWorkflowPromise),
			]);
			const context: z.infer<typeof tokenSchema> = {
				...request,
				orgId: video.orgId,
				bucket: video.bucket,
				storageIntegrationId: video.storageIntegrationId,
				source: JSON.stringify(video.source),
				outputKey,
				transferBudgetBytes,
				expiresAt: Date.now() + 10 * 60_000,
			};
			const encoded = Buffer.from(JSON.stringify(context)).toString(
				"base64url",
			);
			return {
				status: "prepared" as const,
				outputUrl,
				verificationUrl,
				token: `${encoded}.${sign(encoded, secret)}`,
				transferBudgetBytes,
			};
		}
		const parsed = publishSchema.safeParse(payload);
		if (!parsed.success) return unchanged("invalid-request");
		const result = parsed.data;
		const maximumGain = Math.min(
			28,
			Math.max(12, -22 - result.inputLufs),
			-16 - result.inputLufs,
		);
		if (
			result.outputLufs < result.inputLufs + 0.5 ||
			result.outputLufs > result.inputLufs + maximumGain + 0.75
		)
			return unchanged("invalid-levels");
		const context = decodeToken(result.token, secret);
		if (result.outputSize * 2 > context.transferBudgetBytes)
			return unchanged("transfer-budget");
		const id = Video.VideoId.make(context.videoId);
		const published = await db().transaction(async (tx) => {
			const [video] = await tx
				.select()
				.from(videos)
				.where(eq(videos.id, id))
				.for("update");
			if (
				!video ||
				video.ownerId !== context.userId ||
				video.orgId !== context.orgId ||
				video.bucket !== context.bucket ||
				video.storageIntegrationId !== context.storageIntegrationId ||
				JSON.stringify(video.source) !== context.source ||
				originalKey(video) !== context.sourceKey
			)
				return false;
			const [upload] = await tx
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, id));
			if (
				upload ||
				(video.source.type !== "desktopMP4" && video.source.type !== "webMP4")
			)
				return false;
			const [bucket] = await Storage.getAccessForVideo(
				decodeStorageVideo(video),
				{
					resolvePublishedOutput: false,
				},
			).pipe(runWorkflowPromise);
			const [source, output] = await Promise.all([
				bucket
					.headObject(context.sourceKey)
					.pipe(Effect.timeout("10 seconds"), runWorkflowPromise),
				bucket
					.headObject(context.outputKey)
					.pipe(Effect.timeout("10 seconds"), runWorkflowPromise),
			]);
			if (
				source.ETag !== context.sourceIdentity ||
				source.ContentLength !== context.sourceSize ||
				output.ETag !== result.outputIdentity ||
				output.ContentLength !== result.outputSize
			)
				return false;
			await tx
				.update(videos)
				.set({
					source: {
						...video.source,
						audioLevelSourceKey: context.sourceKey,
						audioLevelOutputKey: context.outputKey,
					},
				})
				.where(eq(videos.id, id));
			return true;
		});
		console.info("[audio-levels] Publication", {
			videoId: context.videoId,
			published,
			inputLufs: result.inputLufs,
			outputLufs: result.outputLufs,
			truePeak: result.truePeak,
		});
		return {
			status: published ? ("published" as const) : ("unchanged" as const),
		};
	} catch {
		return unchanged("unavailable");
	}
}
