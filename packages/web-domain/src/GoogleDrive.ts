import { Schema } from "effect";
import { UserId } from "./User.ts";

export const GoogleDriveConfigId = Schema.String.pipe(
	Schema.brand("GoogleDriveConfigId"),
);
export type GoogleDriveConfigId = typeof GoogleDriveConfigId.Type;

export class GoogleDriveConfig extends Schema.Class<GoogleDriveConfig>(
	"GoogleDriveConfig",
)({
	id: GoogleDriveConfigId,
	ownerId: UserId,
	accessToken: Schema.String,
	refreshToken: Schema.String,
	expiresAt: Schema.Number,
	email: Schema.OptionFromNullOr(Schema.String),
	folderId: Schema.OptionFromNullOr(Schema.String),
	folderName: Schema.OptionFromNullOr(Schema.String),
}) {}

export const Workflows = [] as const;

export const decodeSync = Schema.decodeSync(GoogleDriveConfig);

export class GoogleDriveError extends Schema.TaggedError<GoogleDriveError>()(
	"GoogleDriveError",
	{
		cause: Schema.Unknown,
	},
) {}
