import { Context, type Option, Schema } from "effect";
import { HttpApiError, HttpApiMiddleware } from "effect/http-api";
import { RpcMiddleware } from "effect/rpc";

import { InternalError } from "./Errors.ts";
import type { ImageUpload, Organisation, User } from "./index.ts";

export class CurrentUser extends Context.Service<
	CurrentUser,
	{
		id: User.UserId;
		email: string;
		activeOrganizationId: Organisation.OrganisationId;
		iconUrlOrKey: Option.Option<ImageUpload.ImageUrlOrKey>;
	}
>()("CurrentUser") {}

export class HttpAuthMiddleware extends HttpApiMiddleware.Service<
	HttpAuthMiddleware,
	{ provides: CurrentUser }
>()("HttpAuthMiddleware", {
	error: Schema.Union([
		HttpApiError.Unauthorized,
		HttpApiError.InternalServerError,
		HttpApiError.BadRequest,
	]),
}) {}

export class UnauthenticatedError extends Schema.TaggedError<UnauthenticatedError>()(
	"UnauthenticatedError",
	{},
) {}

export class RpcAuthMiddleware extends RpcMiddleware.Service<
	RpcAuthMiddleware,
	{ provides: CurrentUser }
>()("RpcAuthMiddleware", {
	error: Schema.Union([InternalError, UnauthenticatedError]),
}) {}
