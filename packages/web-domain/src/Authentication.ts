import { HttpApiError, HttpApiMiddleware } from "@effect/platform";
import { RpcMiddleware } from "@effect/rpc";
import { Context, type Option, Schema } from "effect";

import { InternalError } from "./Errors.ts";
import type { ImageUpload, Organisation, User } from "./index.ts";

export class CurrentUser extends Context.Tag("CurrentUser")<
	CurrentUser,
	{
		id: User.UserId;
		email: string;
		activeOrganizationId: Organisation.OrganisationId;
		iconUrlOrKey: Option.Option<ImageUpload.ImageUrlOrKey>;
	}
>() {}

export class HttpAuthMiddleware extends HttpApiMiddleware.Tag<HttpAuthMiddleware>()(
	"HttpAuthMiddleware",
	{
		provides: CurrentUser,
		failure: Schema.Union(
			HttpApiError.Unauthorized,
			HttpApiError.InternalServerError,
			HttpApiError.BadRequest,
		),
	},
) {}

export class UnauthenticatedError extends Schema.TaggedError<UnauthenticatedError>()(
	"UnauthenticatedError",
	{},
) {}

export class RpcAuthMiddleware extends RpcMiddleware.Tag<RpcAuthMiddleware>()(
	"RpcAuthMiddleware",
	{
		provides: CurrentUser,
		failure: Schema.Union(InternalError, UnauthenticatedError),
	},
) {}
