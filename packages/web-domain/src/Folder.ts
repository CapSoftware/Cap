import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import { RpcAuthMiddleware } from "./Authentication";
import { InternalError } from "./Errors";
import { PolicyDeniedError } from "./Policy";

export const FolderId = Schema.String.pipe(Schema.brand("FolderId"));
export type FolderId = typeof FolderId.Type;

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
	"FolderNotFoundError",
	{},
) {}

export class FolderRpcs extends RpcGroup.make(
	Rpc.make("FolderDelete", {
		payload: FolderId,
		error: Schema.Union(NotFoundError, InternalError, PolicyDeniedError),
	}).middleware(RpcAuthMiddleware),
) {}
