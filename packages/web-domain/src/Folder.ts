import { HttpApiSchema } from "@effect/platform";
import { Rpc, RpcGroup } from "@effect/rpc";
import { Effect, Schema } from "effect";
import { RpcAuthMiddleware } from "./Authentication.ts";
import { InternalError } from "./Errors.ts";
import { OrganisationId } from "./Organisation.ts";
import { PolicyDeniedError } from "./Policy.ts";
import { SpaceId } from "./Space.ts";
import { UserId } from "./User.ts";

export const FolderId = Schema.String.pipe(Schema.brand("FolderId"));
export type FolderId = typeof FolderId.Type;

export const FolderColor = Schema.Literal("normal", "blue", "red", "yellow");
export type FolderColor = (typeof FolderColor)["Type"];

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
	"FolderNotFoundError",
	{},
	HttpApiSchema.annotations({ status: 404 }),
) {}

// A folder can't be declared within itself.
export class RecursiveDefinitionError extends Schema.TaggedError<RecursiveDefinitionError>()(
	"RecursiveDefinitionError",
	{},
	HttpApiSchema.annotations({ status: 409 }),
) {}

// Attempted to assign a parent to a folder which doesn't exist.
export class ParentNotFoundError extends Schema.TaggedError<ParentNotFoundError>()(
	"ParentNotFoundError",
	{},
	HttpApiSchema.annotations({ status: 404 }),
) {}

export class Folder extends Schema.Class<Folder>("Folder")({
	id: FolderId,
	name: Schema.String,
	color: FolderColor,
	organizationId: OrganisationId,
	createdById: UserId,
	spaceId: Schema.OptionFromNullOr(Schema.String),
	parentId: Schema.OptionFromNullOr(FolderId),
}) {}

export const FolderUpdate = Schema.Struct({
	id: FolderId,
	name: Schema.optional(Schema.String),
	color: Schema.optional(FolderColor),
	parentId: Schema.optional(Schema.Option(FolderId)),
});
export type FolderUpdate = Schema.Schema.Type<typeof FolderUpdate>;

export class FolderRpcs extends RpcGroup.make(
	Rpc.make("FolderDelete", {
		payload: FolderId,
		error: Schema.Union(NotFoundError, InternalError, PolicyDeniedError),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("FolderCreate", {
		payload: Schema.Struct({
			name: Schema.String,
			color: FolderColor,
			spaceId: Schema.OptionFromUndefinedOr(SpaceId),
			parentId: Schema.OptionFromUndefinedOr(FolderId),
		}),
		error: Schema.Union(NotFoundError, InternalError, PolicyDeniedError),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("FolderUpdate", {
		payload: FolderUpdate,
		error: Schema.Union(
			RecursiveDefinitionError,
			ParentNotFoundError,
			PolicyDeniedError,
			NotFoundError,
			InternalError,
		),
	}).middleware(RpcAuthMiddleware),
) {}
