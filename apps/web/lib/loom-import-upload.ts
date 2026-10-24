import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Storage } from "@cap/web-backend/src/Storage/index";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
	LOOM_IMPORT_MAX_BYTES,
	LOOM_IMPORT_PART_BYTES,
} from "@/lib/loom-import-limits";
import { isStorageObjectNotFound } from "@/lib/storage-not-found";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

export {
	LOOM_IMPORT_MAX_BYTES,
	LOOM_IMPORT_PART_BYTES,
} from "@/lib/loom-import-limits";

type Bucket = Effect.Effect.Success<
	ReturnType<typeof Storage.getAccessForVideo>
>[0];
type UploadReceipt = NonNullable<VideoMetadata["loomImportUpload"]>;

export type LoomMultipartUploadTarget = {
	type: "multipart";
	videoId: string;
	key: string;
	uploadId: string;
	partSize: number;
	signPartUrl: string;
	completeUrl: string;
	abortUrl: string;
	webhookSecret: string;
	loomImportAttemptId: string;
};

export async function prepareLoomMultipartUploads({
	video,
	bucket,
	attemptId,
	sourceKey,
	webhookBaseUrl,
	webhookSecret,
}: {
	video: typeof videos.$inferSelect;
	bucket: Bucket;
	attemptId: string;
	sourceKey?: string;
	webhookBaseUrl: string;
	webhookSecret?: string;
}): Promise<{
	sourceUpload?: LoomMultipartUploadTarget;
	outputUpload?: LoomMultipartUploadTarget;
	existingOutput?: { url: string; objectIdentity: string; fileSize: number };
}> {
	if (bucket.provider !== "s3") return {};
	if (!webhookSecret)
		throw new Error(
			"Loom multipart uploads require media server authentication",
		);
	const run = video.metadata?.loomImportRun;
	if (run && !attemptId.startsWith(`${run.runId}:`)) {
		throw new Error("Loom import workflow ownership changed");
	}
	const previous = video.metadata?.loomImportUpload;
	const outputKey = `${video.ownerId}/${video.id}/result.mp4`;
	if (
		previous?.ownerId === video.ownerId &&
		previous.organizationId === video.orgId &&
		previous.output.key === outputKey
	) {
		const output = await bucket.headObject(outputKey).pipe(
			Effect.catchIf(isStorageObjectNotFound, () => Effect.succeed(null)),
			runWorkflowPromise,
		);
		if (output) {
			if (
				!output.ETag ||
				!/^"[^"\r\n]+"$/.test(output.ETag) ||
				!output.ContentLength ||
				output.ContentLength > LOOM_IMPORT_MAX_BYTES
			) {
				throw new Error("Existing Loom output requires storage reconciliation");
			}
			return {
				existingOutput: {
					url: await bucket
						.getInternalSignedObjectUrl(outputKey, { expiresIn: 3 * 60 * 60 })
						.pipe(runWorkflowPromise),
					objectIdentity: output.ETag,
					fileSize: output.ContentLength,
				},
			};
		}
	}
	if (
		sourceKey &&
		(!sourceKey.startsWith(`${video.ownerId}/${video.id}/`) ||
			sourceKey === outputKey)
	) {
		throw new Error("Loom import source key does not match the recording");
	}
	const reusable =
		previous?.attemptId === attemptId &&
		previous.ownerId === video.ownerId &&
		previous.organizationId === video.orgId &&
		previous.output.key === outputKey &&
		(!sourceKey || previous.source?.key === sourceKey);
	let receipt = reusable ? previous : undefined;
	const created: Array<{ key: string; uploadId: string }> = [];
	const create = async (key: string) => {
		const { UploadId: uploadId } = await bucket.multipart
			.create(key, {
				ContentType: key.endsWith(".webm") ? "video/webm" : "video/mp4",
			})
			.pipe(runWorkflowPromise);
		if (!uploadId)
			throw new Error("Storage did not return a multipart upload id");
		const upload = { key, uploadId };
		created.push(upload);
		return upload;
	};
	try {
		if (!receipt) {
			receipt = {
				attemptId,
				ownerId: video.ownerId,
				organizationId: video.orgId,
				source: sourceKey ? await create(sourceKey) : undefined,
				output: await create(outputKey),
			};
			const result = await db()
				.update(videos)
				.set({
					metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.loomImportUpload', JSON_EXTRACT(${JSON.stringify(receipt)}, '$'))`,
				})
				.where(
					and(
						eq(videos.id, video.id),
						eq(videos.ownerId, video.ownerId),
						video.orgId ? eq(videos.orgId, video.orgId) : isNull(videos.orgId),
						run
							? sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomImportRun.runId')) = ${run.runId}`
							: sql`JSON_EXTRACT(${videos.metadata}, '$.loomImportRun') IS NULL`,
						previous
							? sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomImportUpload.attemptId')) = ${previous.attemptId}`
							: sql`JSON_EXTRACT(${videos.metadata}, '$.loomImportUpload') IS NULL`,
					),
				);
			const affectedRows = Array.isArray(result)
				? (result[0] as { affectedRows?: number } | undefined)?.affectedRows
				: (result as { affectedRows?: number }).affectedRows;
			if (affectedRows !== 1)
				throw new Error("Loom import upload ownership changed");
		}
	} catch (error) {
		await Promise.all(
			created.map(({ key, uploadId }) =>
				bucket.multipart.abort(key, uploadId).pipe(
					Effect.catchAll(() => Effect.void),
					runWorkflowPromise,
				),
			),
		);
		throw error;
	}
	const target = (
		upload: UploadReceipt["output"],
	): LoomMultipartUploadTarget => {
		const callback = (action: string) =>
			new URL(`/api/webhooks/media-server/multipart/${action}`, webhookBaseUrl)
				.href;
		return {
			type: "multipart",
			videoId: video.id,
			...upload,
			partSize: LOOM_IMPORT_PART_BYTES,
			signPartUrl: callback("sign-part"),
			completeUrl: callback("complete"),
			abortUrl: callback("abort"),
			webhookSecret,
			loomImportAttemptId: attemptId,
		};
	};
	return {
		sourceUpload:
			sourceKey && receipt.source ? target(receipt.source) : undefined,
		outputUpload: target(receipt.output),
	};
}
