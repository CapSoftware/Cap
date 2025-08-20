import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import { RpcAuthMiddleware } from "./Authentication";
import { InternalError } from "./Errors";
import { PolicyDeniedError } from "./Policy";

export const FolderId = Schema.String.pipe(Schema.brand("FolderId"));
export type FolderId = typeof FolderId.Type;

export const FolderColor = Schema.Literal("normal", "blue", "red", "yellow");
export type FolderColor = (typeof FolderColor)["Type"];

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
	"FolderNotFoundError",
	{},
) {}

export class Folder extends Schema.Class<Folder>("Folder")({
	id: FolderId,
	name: Schema.String,
	color: FolderColor,
	organizationId: Schema.String,
	createdById: Schema.String,
	spaceId: Schema.OptionFromNullOr(Schema.String),
	parentId: Schema.OptionFromNullOr(FolderId),
}) {}

export class FolderRpcs extends RpcGroup.make(
	Rpc.make("FolderDelete", {
		payload: FolderId,
		error: Schema.Union(NotFoundError, InternalError, PolicyDeniedError),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("FolderCreate", {
		payload: Schema.Struct({
			name: Schema.String,
			color: FolderColor,
			spaceId: Schema.OptionFromUndefinedOr(Schema.String),
			parentId: Schema.OptionFromUndefinedOr(FolderId),
		}),
		success: Folder,
		error: Schema.Union(NotFoundError, InternalError),
	}).middleware(RpcAuthMiddleware),
) {}
