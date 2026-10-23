import { createHash } from "node:crypto";
import { Comment, Folder, Organisation, User, Video } from "@cap/web-domain";
import { vi } from "vitest";
import {
	type OwnershipMediaStore,
	type OwnershipSnapshot,
	ownershipCopyMetadata,
	ownershipHash,
	type TransferObject,
} from "@/lib/recording-ownership-transfer";

export const sourcePrefix = "test-owner/test-video/";
export const targetPrefix = "test-target/test-video/";

export const archiveInventory = JSON.stringify({
	version: 1,
	kind: "mp4",
	objects: [
		{
			key: `${sourcePrefix}source/original.mp4`,
			originalKey: `${sourcePrefix}source/original.mp4`,
			originalIdentity: '"test-2"',
			objectIdentity: '"test-2"',
			size: 11,
			track: "mp4",
			index: 0,
		},
	],
});

export function ownershipFixture(): OwnershipSnapshot {
	const videoId = Video.VideoId.make("test-video");
	const date = new Date("2025-01-01T00:00:00Z");
	return {
		folderAccess: {
			folders: [
				{
					id: Folder.FolderId.make("test-folder"),
					organizationId: Organisation.OrganisationId.make("test-org"),
					createdById: User.UserId.make("test-owner"),
					parentId: null,
					spaceId: null,
					public: false,
					updatedAt: date,
				},
			],
			spaces: [],
		},
		comments: [
			{
				id: Comment.CommentId.make("test-comment"),
				mediaKey: `${sourcePrefix}comments/test-comment/media.webm`,
				mediaMeta: {
					mime: "video/webm",
					thumbnailKey: `${sourcePrefix}comments/test-comment/thumbnail.jpg`,
				},
				updatedAt: date,
			},
		],
		video: {
			id: videoId,
			orgId: Organisation.OrganisationId.make("test-org"),
			ownerId: User.UserId.make("test-owner"),
			folderId: Folder.FolderId.make("test-folder"),
			bucket: null,
			storageIntegrationId: null,
			source: {
				type: "desktopMP4",
				outputKey: `${sourcePrefix}.recording/outputs/test/result.mp4`,
				audioLevelOutputKey: `${sourcePrefix}.recording/outputs/audio-quality-v3/test/result.mp4`,
				audioLevelSourceKey: `${sourcePrefix}.recording/outputs/test/result.mp4`,
				thumbnailKey: `${sourcePrefix}.recording/outputs/test/thumbnail.jpg`,
				previewKey: `${sourcePrefix}.recording/outputs/test/preview.gif`,
			},
			metadata: {
				summary: "Synthetic summary",
				desktopRecordingUpload: {
					version: 1,
					artifact: {
						kind: "mp4",
						fileSize: 11,
						duration: 1,
						objectIdentity: '"test-2"',
					},
					fileSize: 11,
					duration: 1,
					hasAudio: true,
					fullDecode: true,
					objectIdentity: '"test-0"',
					sourceObjectIdentity: '"test-2"',
					outputSha256: createHash("sha256")
						.update("synthetic-0")
						.digest("hex"),
					outputKey: `${sourcePrefix}.recording/outputs/test/result.mp4`,
				},
				agentUpload: {
					state: "accepted",
					rawFileKey: `${sourcePrefix}source/original.mp4`,
				},
			},
			transcriptionStatus: "COMPLETE",
			jobStatus: null,
			isScreenshot: false,
			duration: 1,
		},
		upload: {
			videoId,
			uploaded: 11,
			total: 11,
			startedAt: date,
			updatedAt: date,
			mode: "singlepart",
			phase: "complete",
			processingProgress: 100,
			processingMessage: null,
			processingError: null,
			rawFileKey: `${sourcePrefix}source/original.mp4`,
		},
		edit: {
			videoId,
			sourceKey: `${sourcePrefix}source/original.mp4`,
			editSpec: {
				version: 1,
				sourceDuration: 1,
				keepRanges: [{ start: 0, end: 1 }],
			},
			createdAt: date,
			updatedAt: date,
		},
		processing: {
			videoId,
			ownerId: User.UserId.make("test-owner"),
			generation: "test-generation",
			manifestSha256: null,
			state: "verified",
			attemptId: null,
			attemptCount: 1,
			leaseExpiresAt: null,
			nextRetryAt: date,
			workflowRunId: null,
			remoteJobId: null,
			source: {
				version: 1,
				kind: "mp4",
				requiredAudio: false,
				inventoryKey: `${sourcePrefix}.recording/sources/test/inventory.json`,
				inventorySha256: createHash("sha256")
					.update(archiveInventory)
					.digest("hex"),
				mp4: { fileSize: 11, duration: 1, objectIdentity: '"test-2"' },
			},
			verification: {
				version: 1,
				artifact: {
					kind: "mp4",
					fileSize: 11,
					duration: 1,
					objectIdentity: '"test-2"',
				},
				requiredAudio: false,
			},
			output: null,
			errorCode: null,
			errorMessage: null,
			createdAt: date,
			updatedAt: date,
		},
	};
}

export function legacyOwnershipFixture(): OwnershipSnapshot {
	const snapshot = ownershipFixture();
	snapshot.upload = null;
	if (snapshot.video.source.type === "desktopMP4") {
		delete snapshot.video.source.audioLevelOutputKey;
		delete snapshot.video.source.audioLevelSourceKey;
	}
	return snapshot;
}

export function mediaFixture() {
	const objects = new Map<
		string,
		{ bytes: string; identity: string; metadata?: Record<string, string> }
	>(
		[
			".recording/outputs/test/result.mp4",
			".recording/outputs/audio-quality-v3/test/result.mp4",
			"source/original.mp4",
			".recording/outputs/test/thumbnail.jpg",
			".recording/outputs/test/preview.gif",
			"comments/test-comment/media.webm",
			"comments/test-comment/thumbnail.jpg",
			"transcription.vtt",
			".recording/sources/test/inventory.json",
		].map((suffix, index) => [
			`${sourcePrefix}${suffix}`,
			{
				bytes: suffix.endsWith("inventory.json")
					? archiveInventory
					: `synthetic-${index}`,
				identity: `"test-${index}"`,
			},
		]),
	);
	const store: OwnershipMediaStore = {
		readJson: vi.fn(
			async (object) =>
				JSON.parse(objects.get(object.key)?.bytes ?? "") as unknown,
		),
		list: vi.fn(async (prefix) =>
			[...objects.keys()].filter((key) => key.startsWith(prefix)),
		),
		inspect: vi.fn(async (key): Promise<TransferObject> => {
			const object = objects.get(key);
			if (!object) throw new Error("Synthetic object missing");
			return {
				key,
				versionId: null,
				size: Buffer.byteLength(object.bytes),
				identity: object.identity,
				contentType: "application/octet-stream",
				sha256: createHash("sha256").update(object.bytes).digest("hex"),
				metadataHash: ownershipHash(object.metadata ?? {}),
				copyMetadataHash: ownershipHash(
					ownershipCopyMetadata(object.metadata ?? {}),
				),
			};
		}),
		copyIfAbsent: vi.fn(async (source, destinationKey) => {
			const object = objects.get(source.key);
			if (
				!object ||
				object.identity !== source.identity ||
				objects.has(destinationKey)
			)
				throw new Error("Synthetic copy precondition failed");
			objects.set(destinationKey, {
				bytes: object.bytes,
				identity: `"copy-${objects.size}"`,
				metadata: ownershipCopyMetadata(object.metadata ?? {}),
			});
		}),
	};
	return { objects, store };
}
