import { Schema } from "effect";
import { UserId } from "./User.ts";
import type { VideoId } from "./Video.ts";

export const StorageIntegrationId = Schema.String.pipe(
	Schema.brand("StorageIntegrationId"),
);
export type StorageIntegrationId = typeof StorageIntegrationId.Type;

export const StorageObjectId = Schema.String.pipe(
	Schema.brand("StorageObjectId"),
);
export type StorageObjectId = typeof StorageObjectId.Type;

export const StorageProvider = Schema.Literal("googleDrive");
export type StorageProvider = typeof StorageProvider.Type;

export const StorageIntegrationStatus = Schema.Literal(
	"active",
	"error",
	"disconnected",
);
export type StorageIntegrationStatus = typeof StorageIntegrationStatus.Type;

export class StorageIntegration extends Schema.Class<StorageIntegration>(
	"StorageIntegration",
)({
	id: StorageIntegrationId,
	ownerId: UserId,
	provider: StorageProvider,
	displayName: Schema.String,
	status: StorageIntegrationStatus,
	active: Schema.Boolean,
}) {}

export const S3PostUploadTarget = Schema.Struct({
	type: Schema.Literal("s3Post"),
	url: Schema.String,
	fields: Schema.Record({ key: Schema.String, value: Schema.String }),
});

export const PutUploadTarget = Schema.Struct({
	type: Schema.Literal("put"),
	url: Schema.String,
	headers: Schema.Record({ key: Schema.String, value: Schema.String }),
});

export const DriveResumableUploadTarget = Schema.Struct({
	type: Schema.Literal("driveResumable"),
	url: Schema.String,
	headers: Schema.Record({ key: Schema.String, value: Schema.String }),
});

export const UploadTarget = Schema.Union(
	S3PostUploadTarget,
	PutUploadTarget,
	DriveResumableUploadTarget,
);
export type UploadTarget = typeof UploadTarget.Type;

export class StorageError extends Schema.TaggedError<StorageError>()(
	"StorageError",
	{
		cause: Schema.Unknown,
	},
) {}

export type StorageObjectMetadata = {
	videoId?: VideoId;
	fileName?: string;
	contentType?: string;
	duration?: string;
	bandwidth?: string;
	resolution?: string;
	videocodec?: string;
	audiocodec?: string;
};
