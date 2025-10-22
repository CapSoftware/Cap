import { HttpApiSchema } from "@effect/platform";
import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import { RpcAuthMiddleware } from "./Authentication";
import { InternalError } from "./Errors";
import { ImageUpdatePayload } from "./IconImage";
import { PolicyDeniedError } from "./Policy";

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
	"OrgNotFoundError",
	{},
	HttpApiSchema.annotations({ status: 404 }),
) {}

export const OrganisationId = Schema.String.pipe(
	Schema.brand("OrganisationId"),
);
export type OrganisationId = typeof OrganisationId.Type;

export class Organisation extends Schema.Class<Organisation>("Organisation")({
	id: OrganisationId,
	name: Schema.String,
}) {}

export const OrganisationUpdate = Schema.Struct({
	id: OrganisationId,
	image: Schema.optional(ImageUpdatePayload),
});
export type OrganisationUpdate = Schema.Schema.Type<typeof OrganisationUpdate>;

export class OrganisationRpcs extends RpcGroup.make(
	Rpc.make("OrganisationUpdate", {
		payload: OrganisationUpdate,
		error: Schema.Union(InternalError, PolicyDeniedError, NotFoundError),
	}).middleware(RpcAuthMiddleware),
) {}
