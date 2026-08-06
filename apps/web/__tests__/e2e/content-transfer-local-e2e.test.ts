import { createHash } from "node:crypto";
import {
	DeleteObjectsCommand,
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
	ContentTransferPayload,
	ContentTransferProgress,
} from "@/lib/content-transfer";

const enabled = process.env.CAP_CONTENT_TRANSFER_E2E === "1";
const contentTransferE2e = enabled ? describe.sequential : describe.skip;
const databaseName =
	process.env.CAP_CONTENT_TRANSFER_E2E_DATABASE ?? "cap_content_transfer_e2e";
const organizationId = "org_xfer_main";
const actorId = "usr_xfer_admin";
const sourceOwnerId = "usr_xfer_owner";
const targetUserId = "usr_xfer_dest";
const sourceRootFolderId = "fld_xfer_root";
const sourceChildFolderId = "fld_xfer_child";
const destinationRootFolderId = "fld_dest_root";
const destinationChildFolderId = "fld_dest_child";
const videoId = "cap_xfer_one";
const sourceMembershipId = "shr_xfer_one";
const operationId = "op_xfer_main";
const retrySourceFolderId = "fld_retry_src";
const retryDestinationFolderId = "fld_retry_dst";
const retryVideoId = "cap_xfer_retry";
const retryOperationId = "op_xfer_retry";
const driveIntegrationId = "sti_xfer_drive";
const driveVideoId = "cap_drv_page";
const driveObjectCount = 1_002;
const bucket = "capso";
const sourceResultKey = `${sourceOwnerId}/${videoId}/result.mp4`;
const sourcePreviewKey = `${sourceOwnerId}/${videoId}/screenshot.png`;
const destinationResultKey = `${targetUserId}/${videoId}/result.mp4`;
const destinationPreviewKey = `${targetUserId}/${videoId}/screenshot.png`;
const retrySourceKey = `${sourceOwnerId}/${retryVideoId}/result.mp4`;
const retrySourcePreviewKey = `${sourceOwnerId}/${retryVideoId}/screenshot.png`;
const retryDestinationKey = `${targetUserId}/${retryVideoId}/result.mp4`;
const retryDestinationPreviewKey = `${targetUserId}/${retryVideoId}/screenshot.png`;
const retryDestinationTranscriptKey = `${targetUserId}/${retryVideoId}/transcription.vtt`;
const driveObjectPrefix = `${sourceOwnerId}/${driveVideoId}/`;
let connection: Connection;
let s3: S3Client;

function requireRow(rows: RowDataPacket[], label: string) {
	const row = rows[0];
	if (!row) throw new Error(`${label} was not found`);
	return row;
}

function requireIsolatedDatabase() {
	if (!enabled) return;
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error("DATABASE_URL is required");
	const parsed = new URL(databaseUrl);
	if (
		parsed.hostname !== "127.0.0.1" ||
		parsed.port !== "3306" ||
		parsed.pathname !== `/${databaseName}`
	) {
		throw new Error(
			"Content transfer E2E requires its isolated local database",
		);
	}
}

requireIsolatedDatabase();

const payload: ContentTransferPayload = {
	version: 1,
	organizationId,
	requestedByUserId: actorId,
	source: { type: "organization" },
	sourceRootFolderId,
	sourceFolderIds: [sourceRootFolderId, sourceChildFolderId],
	targetUserId,
	targetEmail: "destination@cap.local",
	folderPlan: [
		{
			sourceFolderId: sourceRootFolderId,
			sourceParentId: null,
			sourcePublic: false,
			destinationFolderId: destinationRootFolderId,
			destinationParentId: null,
			name: "Owner backup",
			color: "blue",
			create: true,
		},
		{
			sourceFolderId: sourceChildFolderId,
			sourceParentId: sourceRootFolderId,
			sourcePublic: false,
			destinationFolderId: destinationChildFolderId,
			destinationParentId: destinationRootFolderId,
			name: "Projects",
			color: "normal",
			create: true,
		},
	],
	videoPlan: [
		{
			videoId,
			name: "Synthetic ownership transfer",
			sourceOwnerId,
			sourceMembershipId,
			sourceFolderId: sourceChildFolderId,
			destinationFolderId: destinationChildFolderId,
			bucketId: null,
			storageIntegrationId: null,
			sourceUploadPhase: "complete",
		},
	],
	createdAt: "2026-07-21T12:00:00.000Z",
};

const retryPayload: ContentTransferPayload = {
	version: 1,
	organizationId,
	requestedByUserId: actorId,
	source: { type: "organization" },
	sourceRootFolderId: retrySourceFolderId,
	sourceFolderIds: [retrySourceFolderId],
	targetUserId,
	targetEmail: "destination@cap.local",
	folderPlan: [
		{
			sourceFolderId: retrySourceFolderId,
			sourceParentId: null,
			sourcePublic: false,
			destinationFolderId: retryDestinationFolderId,
			destinationParentId: null,
			name: "Retry folder",
			color: "normal",
			create: false,
		},
	],
	videoPlan: [
		{
			videoId: retryVideoId,
			name: "Synthetic workflow replay",
			sourceOwnerId,
			sourceMembershipId: "shr_retry_old",
			sourceFolderId: retrySourceFolderId,
			destinationFolderId: retryDestinationFolderId,
			bucketId: null,
			storageIntegrationId: null,
			sourceUploadPhase: "complete",
		},
	],
	createdAt: "2026-07-21T12:01:00.000Z",
};

async function seedDatabase() {
	const preferences = JSON.stringify({ notifications: {} });
	await connection.execute(
		`INSERT INTO users
			(id, name, lastName, email, activeOrganizationId, defaultOrgId, inviteQuota, preferences)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			actorId,
			"Transfer",
			"Admin",
			"admin@cap.local",
			organizationId,
			organizationId,
			10,
			preferences,
			sourceOwnerId,
			"Source",
			"Owner",
			"source@cap.local",
			organizationId,
			organizationId,
			10,
			preferences,
			targetUserId,
			"Destination",
			"Member",
			"destination@cap.local",
			organizationId,
			organizationId,
			10,
			preferences,
		],
	);
	await connection.execute(
		"INSERT INTO organizations (id, name, ownerId, settings) VALUES (?, ?, ?, ?)",
		[
			organizationId,
			"Content Transfer E2E",
			actorId,
			JSON.stringify({ aiGenerationLanguage: "auto" }),
		],
	);
	await connection.execute(
		`INSERT INTO organization_members (id, userId, organizationId, role, hasProSeat)
		 VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
		[
			"mem_xfer_admin",
			actorId,
			organizationId,
			"owner",
			true,
			"mem_xfer_owner",
			sourceOwnerId,
			organizationId,
			"member",
			false,
			"mem_xfer_dest",
			targetUserId,
			organizationId,
			"member",
			false,
		],
	);
	const { encrypt } = await import("@cap/database/crypto");
	const encryptedConfig = await encrypt(
		JSON.stringify({ refreshToken: "test", folderId: "test" }),
	);
	await connection.execute(
		`INSERT INTO storage_integrations
			(id, ownerId, organizationId, provider, displayName, status, active, encryptedConfig)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			driveIntegrationId,
			actorId,
			organizationId,
			"googleDrive",
			"Pagination test",
			"active",
			true,
			encryptedConfig,
		],
	);
	const driveObjects = Array.from({ length: driveObjectCount }, (_, index) => {
		const suffix = index.toString().padStart(4, "0");
		const objectKey = `${driveObjectPrefix}segment-${suffix}.m4s`;
		return {
			id: `obj_drv_${suffix}`,
			objectKey,
			objectKeyHash: createHash("sha256").update(objectKey).digest("hex"),
			providerObjectId: `drive-${suffix}`,
		};
	});
	for (let index = 0; index < driveObjects.length; index += 250) {
		const chunk = driveObjects.slice(index, index + 250);
		await connection.execute(
			`INSERT INTO storage_objects
				(id, integrationId, ownerId, videoId, objectKey, objectKeyHash, providerObjectId, uploadStatus, contentType, contentLength)
			 VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
			chunk.flatMap((object) => [
				object.id,
				driveIntegrationId,
				sourceOwnerId,
				null,
				object.objectKey,
				object.objectKeyHash,
				object.providerObjectId,
				"complete",
				"video/iso.segment",
				16,
			]),
		);
	}
	await connection.execute(
		`INSERT INTO folders
			(id, name, color, public, organizationId, createdById, parentId, spaceId)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			sourceRootFolderId,
			"Owner backup",
			"blue",
			false,
			organizationId,
			actorId,
			null,
			organizationId,
			sourceChildFolderId,
			"Projects",
			"normal",
			false,
			organizationId,
			actorId,
			sourceRootFolderId,
			organizationId,
		],
	);
	await connection.execute(
		`INSERT INTO videos
			(id, ownerId, orgId, name, metadata, public, settings, transcriptionStatus, source, folderId)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			videoId,
			sourceOwnerId,
			organizationId,
			"Synthetic ownership transfer",
			JSON.stringify({ customCreatedAt: "2025-05-04T12:00:00.000Z" }),
			true,
			JSON.stringify({ defaultPlaybackSpeed: 1.25 }),
			"COMPLETE",
			JSON.stringify({ type: "MediaConvert" }),
			null,
		],
	);
	await connection.execute(
		`INSERT INTO folders
			(id, name, color, public, organizationId, createdById, parentId, spaceId)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			retrySourceFolderId,
			"Retry folder",
			"normal",
			false,
			organizationId,
			actorId,
			null,
			organizationId,
			retryDestinationFolderId,
			"Retry folder",
			"normal",
			false,
			organizationId,
			targetUserId,
			null,
			null,
		],
	);
	await connection.execute(
		`INSERT INTO videos
			(id, ownerId, orgId, name, metadata, public, settings, transcriptionStatus, source, folderId)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			retryVideoId,
			targetUserId,
			organizationId,
			"Synthetic workflow replay",
			JSON.stringify({ customCreatedAt: "2025-06-04T12:00:00.000Z" }),
			true,
			JSON.stringify({}),
			"COMPLETE",
			JSON.stringify({ type: "MediaConvert" }),
			retryDestinationFolderId,
		],
	);
	await connection.execute(
		`INSERT INTO shared_videos
			(id, videoId, folderId, organizationId, sharedByUserId)
		 VALUES (?, ?, ?, ?, ?)`,
		[sourceMembershipId, videoId, sourceChildFolderId, organizationId, actorId],
	);
	await connection.execute(
		`INSERT INTO video_uploads
			(video_id, uploaded, total, mode, phase, processing_progress, raw_file_key)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[videoId, 1024, 1024, "singlepart", "complete", 100, sourceResultKey],
	);
	await connection.execute(
		`INSERT INTO video_uploads
			(video_id, uploaded, total, mode, phase, processing_progress, raw_file_key)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			retryVideoId,
			128,
			128,
			"singlepart",
			"complete",
			100,
			retryDestinationKey,
		],
	);
	await connection.execute(
		`INSERT INTO video_edits (videoId, sourceKey, editSpec)
		 VALUES (?, ?, ?)`,
		[videoId, sourceResultKey, JSON.stringify({ segments: [] })],
	);
	await connection.execute(
		`INSERT INTO comments (id, type, content, timestamp, authorId, videoId)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		["cmt_xfer_one", "text", "Preserve this comment", 0.5, actorId, videoId],
	);
	const progress: ContentTransferProgress = {
		phase: "queued",
		totalVideos: 1,
		processedVideos: 0,
		transferredVideos: 0,
		alreadyOwnedVideos: 0,
		copiedObjects: 0,
		currentVideoId: null,
		removedSourceFolder: false,
		cleanupWarnings: [],
	};
	await connection.execute(
		`INSERT INTO agent_api_operations
			(id, userId, kind, resourceId, state, payload, result)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			operationId,
			actorId,
			"transfer_org_content",
			organizationId,
			"queued",
			JSON.stringify(payload),
			JSON.stringify(progress),
		],
	);
	await connection.execute(
		`INSERT INTO agent_api_operations
			(id, userId, kind, resourceId, state, payload, result)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			retryOperationId,
			actorId,
			"transfer_org_content",
			organizationId,
			"queued",
			JSON.stringify(retryPayload),
			JSON.stringify(progress),
		],
	);
}

contentTransferE2e("organization content transfer local Docker E2E", () => {
	beforeAll(async () => {
		Object.assign(process.env, {
			DATABASE_URL: `mysql://root@127.0.0.1:3306/${databaseName}`,
			DATABASE_ENCRYPTION_KEY: "22".repeat(32),
			NEXTAUTH_SECRET: "synthetic-content-transfer-secret",
			NEXTAUTH_URL: "http://127.0.0.1",
			WEB_URL: "http://127.0.0.1",
			NEXT_PUBLIC_WEB_URL: "http://127.0.0.1",
			NEXT_PUBLIC_IS_CAP: "false",
			NODE_ENV: "test",
			CAP_AWS_BUCKET: bucket,
			CAP_AWS_REGION: "us-east-1",
			CAP_AWS_ACCESS_KEY: "capS3root",
			CAP_AWS_SECRET_KEY: "capS3root",
			CAP_AWS_ENDPOINT: "http://127.0.0.1:9000",
			CAP_AWS_BUCKET_URL: "http://127.0.0.1:9000/capso",
			S3_PATH_STYLE: "true",
		});
		connection = await mysql.createConnection({
			host: "127.0.0.1",
			port: 3306,
			user: "root",
			database: databaseName,
		});
		s3 = new S3Client({
			endpoint: "http://127.0.0.1:9000",
			region: "us-east-1",
			forcePathStyle: true,
			credentials: {
				accessKeyId: "capS3root",
				secretAccessKey: "capS3root",
			},
		});
		await seedDatabase();
		await Promise.all([
			s3.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: sourceResultKey,
					Body: Buffer.alloc(1_024, 7),
					ContentType: "video/mp4",
				}),
			),
			s3.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: sourcePreviewKey,
					Body: Buffer.alloc(64, 3),
					ContentType: "image/png",
				}),
			),
			s3.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: retrySourceKey,
					Body: Buffer.alloc(128, 5),
					ContentType: "video/mp4",
				}),
			),
			s3.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: retrySourcePreviewKey,
					Body: Buffer.alloc(32, 4),
					ContentType: "image/png",
				}),
			),
			s3.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: retryDestinationKey,
					Body: Buffer.alloc(128, 5),
					ContentType: "video/mp4",
				}),
			),
			s3.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: retryDestinationPreviewKey,
					Body: Buffer.alloc(32, 4),
					ContentType: "image/png",
				}),
			),
			s3.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: retryDestinationTranscriptKey,
					Body: Buffer.alloc(16, 2),
					ContentType: "text/vtt",
				}),
			),
		]);
	}, 60_000);

	afterAll(async () => {
		if (s3) {
			const keys = [
				sourceResultKey,
				sourcePreviewKey,
				destinationResultKey,
				destinationPreviewKey,
				retrySourceKey,
				retrySourcePreviewKey,
				retryDestinationKey,
				retryDestinationPreviewKey,
				retryDestinationTranscriptKey,
			];
			for (let index = 0; index < keys.length; index += 1_000) {
				await s3.send(
					new DeleteObjectsCommand({
						Bucket: bucket,
						Delete: {
							Objects: keys.slice(index, index + 1_000).map((Key) => ({ Key })),
						},
					}),
				);
			}
		}
		if (connection) await connection.end();
	});

	it("paginates every Google Drive-backed object beyond the first 1,000", async () => {
		const { Storage: StorageService } = await import(
			"@cap/web-backend/src/Storage/index"
		);
		const {
			Organisation,
			Storage: StorageDomain,
			User,
			Video,
		} = await import("@cap/web-domain");
		const { Option } = await import("effect");
		const { runWorkflowPromise } = await import("@/lib/workflow-runtime");
		const storageVideo = Video.Video.make({
			id: Video.VideoId.make(driveVideoId),
			ownerId: User.UserId.make(sourceOwnerId),
			orgId: Organisation.OrganisationId.make(organizationId),
			name: "Google Drive pagination",
			public: false,
			source: { type: "MediaConvert" },
			metadata: Option.none(),
			bucketId: Option.none(),
			storageIntegrationId: Option.some(
				StorageDomain.StorageIntegrationId.make(driveIntegrationId),
			),
			folderId: Option.none(),
			transcriptionStatus: Option.none(),
			width: Option.none(),
			height: Option.none(),
			duration: Option.none(),
			createdAt: new Date(0),
			updatedAt: new Date(0),
		});
		const [access] =
			await StorageService.getAccessForVideo(storageVideo).pipe(
				runWorkflowPromise,
			);
		const keys: string[] = [];
		const pageSizes: number[] = [];
		let continuationToken: string | undefined;
		do {
			const page = await access
				.listObjects({
					prefix: driveObjectPrefix,
					maxKeys: 1_000,
					continuationToken,
				})
				.pipe(runWorkflowPromise);
			const pageKeys = (page.Contents ?? []).flatMap((object) =>
				object.Key ? [object.Key] : [],
			);
			keys.push(...pageKeys);
			pageSizes.push(pageKeys.length);
			continuationToken = page.IsTruncated
				? page.NextContinuationToken
				: undefined;
		} while (continuationToken);

		expect(pageSizes).toEqual([1_000, 2]);
		expect(keys).toEqual(
			Array.from(
				{ length: driveObjectCount },
				(_, index) =>
					`${driveObjectPrefix}segment-${index.toString().padStart(4, "0")}.m4s`,
			),
		);
	}, 60_000);

	it("transfers ownership, hierarchy, and media without changing Cap identity", async () => {
		const { transferOrganizationContentWorkflow } = await import(
			"@/workflows/transfer-organization-content"
		);
		await transferOrganizationContentWorkflow({ operationId });

		const [videoRows] = await connection.query<RowDataPacket[]>(
			"SELECT id, ownerId, folderId, name, public, metadata, settings, source FROM videos WHERE id = ?",
			[videoId],
		);
		const video = requireRow(videoRows, "Transferred Cap");
		expect(video).toMatchObject({
			id: videoId,
			ownerId: targetUserId,
			folderId: destinationChildFolderId,
			name: "Synthetic ownership transfer",
			public: 1,
		});
		expect(video.metadata).toEqual({
			customCreatedAt: "2025-05-04T12:00:00.000Z",
		});
		expect(video.settings).toEqual({ defaultPlaybackSpeed: 1.25 });
		expect(video.source).toEqual({ type: "MediaConvert" });

		const [destinationFolders] = await connection.query<RowDataPacket[]>(
			"SELECT id, parentId, createdById, spaceId, public FROM folders WHERE id IN (?, ?) ORDER BY id",
			[destinationRootFolderId, destinationChildFolderId],
		);
		expect(destinationFolders).toEqual([
			expect.objectContaining({
				id: destinationChildFolderId,
				parentId: destinationRootFolderId,
				createdById: targetUserId,
				spaceId: null,
				public: 0,
			}),
			expect.objectContaining({
				id: destinationRootFolderId,
				parentId: null,
				createdById: targetUserId,
				spaceId: null,
				public: 0,
			}),
		]);

		const [
			placementResult,
			sourceFolderResult,
			commentResult,
			uploadResult,
			editResult,
		] = await Promise.all([
			connection.query<RowDataPacket[]>(
				"SELECT COUNT(*) AS count FROM shared_videos WHERE id = ?",
				[sourceMembershipId],
			),
			connection.query<RowDataPacket[]>(
				"SELECT COUNT(*) AS count FROM folders WHERE id IN (?, ?)",
				[sourceRootFolderId, sourceChildFolderId],
			),
			connection.query<RowDataPacket[]>(
				"SELECT COUNT(*) AS count FROM comments WHERE videoId = ?",
				[videoId],
			),
			connection.query<RowDataPacket[]>(
				"SELECT raw_file_key AS rawFileKey FROM video_uploads WHERE video_id = ?",
				[videoId],
			),
			connection.query<RowDataPacket[]>(
				"SELECT sourceKey FROM video_edits WHERE videoId = ?",
				[videoId],
			),
		]);
		const placement = requireRow(placementResult[0], "Placement count");
		const sourceFolder = requireRow(
			sourceFolderResult[0],
			"Source folder count",
		);
		const comment = requireRow(commentResult[0], "Comment count");
		const upload = requireRow(uploadResult[0], "Video upload");
		const edit = requireRow(editResult[0], "Video edit");
		expect(placement.count).toBe(0);
		expect(sourceFolder.count).toBe(0);
		expect(comment.count).toBe(1);
		expect(upload.rawFileKey).toBe(destinationResultKey);
		expect(edit.sourceKey).toBe(destinationResultKey);

		const [resultObject, previewObject] = await Promise.all([
			s3.send(
				new GetObjectCommand({ Bucket: bucket, Key: destinationResultKey }),
			),
			s3.send(
				new GetObjectCommand({ Bucket: bucket, Key: destinationPreviewKey }),
			),
		]);
		expect(resultObject.ContentLength).toBe(1_024);
		expect(previewObject.ContentLength).toBe(64);
		await expect(
			s3.send(new GetObjectCommand({ Bucket: bucket, Key: sourceResultKey })),
		).rejects.toBeDefined();

		const [operationRows] = await connection.query<RowDataPacket[]>(
			"SELECT state, result, errorMessage FROM agent_api_operations WHERE id = ?",
			[operationId],
		);
		const operation = requireRow(operationRows, "Transfer operation");
		expect(operation.state).toBe("succeeded");
		expect(operation.errorMessage).toBeNull();
		expect(operation.result).toMatchObject({
			processedVideos: 1,
			transferredVideos: 1,
			copiedObjects: 2,
			removedSourceFolder: true,
			cleanupWarnings: [],
		});
	}, 60_000);

	it("finishes safely when a durable step replays after partial source cleanup", async () => {
		const { transferOrganizationContentWorkflow } = await import(
			"@/workflows/transfer-organization-content"
		);
		await transferOrganizationContentWorkflow({
			operationId: retryOperationId,
		});

		const [videoRows] = await connection.query<RowDataPacket[]>(
			"SELECT ownerId, folderId FROM videos WHERE id = ?",
			[retryVideoId],
		);
		expect(requireRow(videoRows, "Replay Cap")).toMatchObject({
			ownerId: targetUserId,
			folderId: retryDestinationFolderId,
		});
		const [sourceFolderRows] = await connection.query<RowDataPacket[]>(
			"SELECT COUNT(*) AS count FROM folders WHERE id = ?",
			[retrySourceFolderId],
		);
		expect(requireRow(sourceFolderRows, "Replay source count").count).toBe(0);
		const [operationRows] = await connection.query<RowDataPacket[]>(
			"SELECT state, result FROM agent_api_operations WHERE id = ?",
			[retryOperationId],
		);
		const operation = requireRow(operationRows, "Replay operation");
		expect(operation.state).toBe("succeeded");
		expect(operation.result).toMatchObject({
			processedVideos: 1,
			transferredVideos: 0,
			alreadyOwnedVideos: 1,
			copiedObjects: 0,
			removedSourceFolder: true,
		});
		const [resultObject, previewObject, transcriptObject] = await Promise.all([
			s3.send(
				new GetObjectCommand({ Bucket: bucket, Key: retryDestinationKey }),
			),
			s3.send(
				new GetObjectCommand({
					Bucket: bucket,
					Key: retryDestinationPreviewKey,
				}),
			),
			s3.send(
				new GetObjectCommand({
					Bucket: bucket,
					Key: retryDestinationTranscriptKey,
				}),
			),
		]);
		expect(resultObject.ContentLength).toBe(128);
		expect(previewObject.ContentLength).toBe(32);
		expect(transcriptObject.ContentLength).toBe(16);
		await expect(
			s3.send(new GetObjectCommand({ Bucket: bucket, Key: retrySourceKey })),
		).rejects.toBeDefined();
		await expect(
			s3.send(
				new GetObjectCommand({ Bucket: bucket, Key: retrySourcePreviewKey }),
			),
		).rejects.toBeDefined();
	});
});
