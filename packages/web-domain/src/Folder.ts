import { Rpc, RpcGroup } from "@effect/rpc";
import { Effect, Schema } from "effect";

import { RpcAuthMiddleware } from "./Authentication.ts";
import { InternalError } from "./Errors.ts";
import { PolicyDeniedError } from "./Policy.ts";

export const FolderId = Schema.String.pipe(Schema.brand("FolderId"));
export type FolderId = typeof FolderId.Type;

export const FolderColor = Schema.Literal("normal", "blue", "red", "yellow");
export type FolderColor = (typeof FolderColor)["Type"];

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
	"FolderNotFoundError",
	{},
) {}

// A folder can't be declared within itself.
export class RecursiveDefinitionError extends Schema.TaggedError<RecursiveDefinitionError>()(
	"RecursiveDefinitionError",
	{},
) {}

// Attempted to assign a parent to a folder which doesn't exist.
export class ParentNotFoundError extends Schema.TaggedError<ParentNotFoundError>()(
	"ParentNotFoundError",
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
}) {
	static decodeSync = Schema.decodeSync(Folder);

	static toJS = (self: Folder) =>
		Schema.encode(Folder)(self).pipe(Effect.orDie);
}

export class FolderUpdate extends Schema.Class<FolderUpdate>("FolderPatch")({
	id: FolderId,
	name: Schema.optional(Schema.String),
	color: Schema.optional(FolderColor),
	parentId: Schema.optional(FolderId),
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
	Rpc.make("FolderUpdate", {
		payload: FolderUpdate,
		error: Schema.Union(
			NotFoundError,
			RecursiveDefinitionError,
			ParentNotFoundError,
			InternalError,
		),
	}).middleware(RpcAuthMiddleware),
) {}
