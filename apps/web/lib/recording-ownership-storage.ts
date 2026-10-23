import { createHash } from "node:crypto";
import type { Storage } from "@cap/web-backend/src/Storage/index";
import type { Effect } from "effect";
import {
	type OwnershipMediaStore,
	OwnershipTransferError,
	ownershipCopyMetadata,
	ownershipHash,
	type TransferObject,
} from "@/lib/recording-ownership-transfer";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

type Access = Effect.Effect.Success<
	ReturnType<typeof Storage.getAccessForVideo>
>[0];

function contentType(value: string | undefined) {
	const type =
		value?.split(";")[0]?.trim().toLowerCase() ?? "application/octet-stream";
	if (
		!new Set([
			"video/mp4",
			"video/webm",
			"video/quicktime",
			"video/mp2t",
			"audio/mp4",
			"audio/webm",
			"audio/mpeg",
			"audio/aac",
			"audio/ogg",
			"audio/wav",
			"audio/x-wav",
			"application/json",
			"application/octet-stream",
			"application/vnd.apple.mpegurl",
			"application/x-mpegurl",
			"text/plain",
			"text/vtt",
			"image/jpeg",
			"image/png",
			"image/gif",
			"image/webp",
		]).has(type)
	) {
		throw new OwnershipTransferError("UNSUPPORTED");
	}
	return type;
}

export function makeOwnershipMediaStore(access: Access): OwnershipMediaStore {
	if (access.provider !== "s3" || !access.multipart.copyPart) {
		throw new OwnershipTransferError("UNSUPPORTED");
	}
	const copyPart = access.multipart.copyPart;
	return {
		async head(key) {
			const head = await access.headObject(key).pipe(runWorkflowPromise);
			if (
				!head.ETag ||
				!head.ContentLength ||
				!Number.isSafeInteger(head.ContentLength)
			)
				throw new OwnershipTransferError("INVALID_REFERENCE");
			return {
				key,
				size: head.ContentLength,
				identity: head.ETag,
				versionId: head.VersionId ?? null,
				contentType: contentType(head.ContentType),
				metadataHash: ownershipHash(head.Metadata ?? {}),
				copyMetadataHash: ownershipHash(
					ownershipCopyMetadata(head.Metadata ?? {}),
				),
			};
		},
		async signRead(key, versionId) {
			return access
				.getInternalSignedObjectUrl(key, {
					expiresIn: 24 * 60 * 60,
					...(versionId ? { versionId } : {}),
				})
				.pipe(runWorkflowPromise);
		},
		async readJson(object) {
			if (object.size > 4 * 1024 * 1024)
				throw new OwnershipTransferError("UNSUPPORTED");
			const url = await access
				.getInternalSignedObjectUrl(
					object.key,
					object.versionId ? { versionId: object.versionId } : undefined,
				)
				.pipe(runWorkflowPromise);
			const response = await fetch(url, {
				headers: { "If-Match": object.identity, "Accept-Encoding": "identity" },
				redirect: "error",
				signal: AbortSignal.timeout(60_000),
			});
			if (!response.ok || !response.body) {
				await response.body?.cancel();
				throw new OwnershipTransferError("STORAGE_FAILED");
			}
			const chunks: Uint8Array[] = [];
			let size = 0;
			for await (const chunk of response.body) {
				size += chunk.length;
				if (size > object.size)
					throw new OwnershipTransferError("MEDIA_CHANGED");
				chunks.push(chunk);
			}
			const bytes = Buffer.concat(chunks);
			if (
				size !== object.size ||
				createHash("sha256").update(bytes).digest("hex") !== object.sha256
			)
				throw new OwnershipTransferError("MEDIA_CHANGED");
			try {
				return JSON.parse(bytes.toString("utf8")) as unknown;
			} catch {
				throw new OwnershipTransferError("INVALID_REFERENCE");
			}
		},
		async list(prefix) {
			const keys: string[] = [];
			let continuationToken: string | undefined;
			const seen = new Set<string>();
			do {
				const page = await access
					.listObjects({ prefix, continuationToken, maxKeys: 1000 })
					.pipe(runWorkflowPromise);
				for (const object of page.Contents ?? []) {
					if (!object.Key?.startsWith(prefix) || keys.length >= 10_000) {
						throw new OwnershipTransferError("INVALID_REFERENCE");
					}
					keys.push(object.Key);
				}
				if (!page.IsTruncated) break;
				continuationToken = page.NextContinuationToken;
				if (!continuationToken || seen.has(continuationToken)) {
					throw new OwnershipTransferError("STORAGE_FAILED");
				}
				seen.add(continuationToken);
			} while (continuationToken);
			return keys;
		},
		async inspect(key): Promise<TransferObject> {
			const head = await access.headObject(key).pipe(runWorkflowPromise);
			if (
				!head.ETag ||
				!head.ContentLength ||
				!Number.isSafeInteger(head.ContentLength)
			) {
				throw new OwnershipTransferError("INVALID_REFERENCE");
			}
			const url = await access
				.getInternalSignedObjectUrl(
					key,
					head.VersionId ? { versionId: head.VersionId } : undefined,
				)
				.pipe(runWorkflowPromise);
			const response = await fetch(url, {
				headers: { "If-Match": head.ETag, "Accept-Encoding": "identity" },
				redirect: "error",
				signal: AbortSignal.timeout(30 * 60 * 1000),
			});
			if (!response.ok || !response.body) {
				await response.body?.cancel();
				throw new OwnershipTransferError("STORAGE_FAILED");
			}
			const hash = createHash("sha256");
			let size = 0;
			for await (const chunk of response.body) {
				size += chunk.length;
				hash.update(chunk);
				if (size > head.ContentLength)
					throw new OwnershipTransferError("MEDIA_CHANGED");
			}
			const after = await access.headObject(key).pipe(runWorkflowPromise);
			if (
				size !== head.ContentLength ||
				after.ContentLength !== size ||
				after.ETag !== head.ETag ||
				after.VersionId !== head.VersionId ||
				contentType(after.ContentType) !== contentType(head.ContentType) ||
				ownershipHash(after.Metadata ?? {}) !==
					ownershipHash(head.Metadata ?? {})
			) {
				throw new OwnershipTransferError("MEDIA_CHANGED");
			}
			return {
				key,
				versionId: head.VersionId ?? null,
				size,
				identity: head.ETag,
				contentType: contentType(head.ContentType),
				sha256: hash.digest("hex"),
				metadataHash: ownershipHash(head.Metadata ?? {}),
				copyMetadataHash: ownershipHash(
					ownershipCopyMetadata(head.Metadata ?? {}),
				),
			};
		},
		async copyIfAbsent(source, destinationKey) {
			const head = await access.headObject(source.key).pipe(runWorkflowPromise);
			if (
				head.ETag !== source.identity ||
				(head.VersionId ?? null) !== (source.versionId ?? null) ||
				head.ContentLength !== source.size ||
				contentType(head.ContentType) !== source.contentType ||
				ownershipHash(head.Metadata ?? {}) !== source.metadataHash
			) {
				throw new OwnershipTransferError("MEDIA_CHANGED");
			}
			const partSize = Math.max(
				128 * 1024 ** 2,
				Math.ceil(source.size / 10_000),
			);
			if (partSize > 5 * 1024 ** 3)
				throw new OwnershipTransferError("UNSUPPORTED");
			const created = await access.multipart
				.create(destinationKey, {
					ContentType: contentType(head.ContentType),
					Metadata: ownershipCopyMetadata(head.Metadata ?? {}),
				})
				.pipe(runWorkflowPromise);
			if (!created.UploadId) throw new OwnershipTransferError("STORAGE_FAILED");
			const uploadId = created.UploadId;
			try {
				const parts: Array<{ PartNumber: number; ETag: string }> = [];
				for (let offset = 0; offset < source.size; offset += partSize) {
					const part = await copyPart(
						destinationKey,
						uploadId,
						parts.length + 1,
						{
							CopySource: `${access.bucketName}/${source.key.split("/").map(encodeURIComponent).join("/")}${source.versionId ? `?versionId=${encodeURIComponent(source.versionId)}` : ""}`,
							CopySourceIfMatch: source.identity,
							CopySourceRange: `bytes=${offset}-${Math.min(source.size, offset + partSize) - 1}`,
						},
					).pipe(runWorkflowPromise);
					if (!part.CopyPartResult?.ETag)
						throw new OwnershipTransferError("STORAGE_FAILED");
					parts.push({
						PartNumber: parts.length + 1,
						ETag: part.CopyPartResult.ETag,
					});
				}
				// CopyObject has no destination precondition. Multipart completion
				// provides create-only publication even for small objects and retries.
				await access.multipart
					.complete(destinationKey, uploadId, {
						MultipartUpload: { Parts: parts },
						IfNoneMatch: "*",
					})
					.pipe(runWorkflowPromise);
			} catch {
				try {
					await access.multipart
						.abort(destinationKey, uploadId)
						.pipe(runWorkflowPromise);
				} catch {
					// An ambiguous completion may already have consumed the upload.
				}
				throw new OwnershipTransferError("STORAGE_FAILED");
			}
		},
	};
}
