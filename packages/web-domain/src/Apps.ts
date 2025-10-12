import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";

import { RpcAuthMiddleware } from "./Authentication.ts";
import { InternalError } from "./Errors.ts";
import { PolicyDeniedError } from "./Policy.ts";

export const AppSlug = Schema.Literal("discord");
export type AppSlug = typeof AppSlug.Type;

export const AppStatus = Schema.Literal(
	"connected",
	"paused",
	"needs_attention",
);
export type AppStatus = typeof AppStatus.Type;

export const AppDestination = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	type: Schema.String,
	parentId: Schema.OptionFromNullOr(Schema.String),
});
export type AppDestination = typeof AppDestination.Type;

export class AppDefinition extends Schema.Class<AppDefinition>("AppDefinition")(
	{
		slug: AppSlug,
		displayName: Schema.String,
		description: Schema.String,
		icon: Schema.String,
		category: Schema.String,
		requiredEnvVars: Schema.Array(Schema.String),
		image: Schema.String,
		documentation: Schema.String,
		content: Schema.String,
		contentPath: Schema.OptionFromNullOr(Schema.String),
		publisher: Schema.Struct({
			name: Schema.String,
			email: Schema.String,
		}),
	},
) {}

export class AppInstallationView extends Schema.Class<AppInstallationView>(
	"AppInstallationView",
)({
	id: Schema.String,
	slug: AppSlug,
	status: AppStatus,
	organizationId: Schema.String,
	spaceId: Schema.OptionFromNullOr(Schema.String),
	providerDisplayName: Schema.OptionFromNullOr(Schema.String),
	providerMetadata: Schema.OptionFromNullOr(Schema.Unknown),
	lastCheckedAt: Schema.OptionFromNullOr(Schema.Date),
	settings: Schema.OptionFromNullOr(Schema.Unknown),
}) {}

export class AppNotInstalledError extends Schema.TaggedError<AppNotInstalledError>()(
	"AppNotInstalledError",
	{
		slug: AppSlug,
	},
) {}

export class AppUnsupportedError extends Schema.TaggedError<AppUnsupportedError>()(
	"AppUnsupportedError",
	{
		slug: Schema.String,
	},
) {}

export class AppSettingsValidationError extends Schema.TaggedError<AppSettingsValidationError>()(
	"AppSettingsValidationError",
	{
		slug: AppSlug,
		issues: Schema.Array(Schema.String),
	},
) {}

export class AppOperationError extends Schema.TaggedError<AppOperationError>()(
	"AppOperationError",
	{
		slug: AppSlug,
		operation: Schema.String,
		reason: Schema.String,
		retryable: Schema.Boolean,
		status: Schema.optional(Schema.Number),
	},
) {}

export class AppSettingsMissingError extends Schema.TaggedError<AppSettingsMissingError>()(
	"AppSettingsMissingError",
	{
		slug: AppSlug,
	},
) {}

const AppSlugPayload = Schema.Struct({ slug: AppSlug });

const UpdateSettingsPayload = Schema.Struct({
	slug: AppSlug,
	settings: Schema.Unknown,
});

export class AppsRpcs extends RpcGroup.make(
	Rpc.make("AppsListDefinitions", {
		payload: Schema.Struct({}),
		success: Schema.Array(AppDefinition),
		error: Schema.Union(PolicyDeniedError, InternalError),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("AppsGetInstallation", {
		payload: AppSlugPayload,
		success: Schema.Option(AppInstallationView),
		error: Schema.Union(AppUnsupportedError, PolicyDeniedError, InternalError),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("AppsListDestinations", {
		payload: AppSlugPayload,
		success: Schema.Array(AppDestination),
		error: Schema.Union(
			AppNotInstalledError,
			AppUnsupportedError,
			AppOperationError,
			PolicyDeniedError,
			InternalError,
		),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("AppsUpdateSettings", {
		payload: UpdateSettingsPayload,
		success: AppInstallationView,
		error: Schema.Union(
			AppNotInstalledError,
			AppUnsupportedError,
			AppSettingsValidationError,
			AppOperationError,
			PolicyDeniedError,
			InternalError,
		),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("AppsVerifyDestination", {
		payload: AppSlugPayload,
		success: AppInstallationView,
		error: Schema.Union(
			AppNotInstalledError,
			AppUnsupportedError,
			AppSettingsMissingError,
			AppOperationError,
			PolicyDeniedError,
			InternalError,
		),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("AppsPause", {
		payload: AppSlugPayload,
		success: AppInstallationView,
		error: Schema.Union(
			AppNotInstalledError,
			AppUnsupportedError,
			AppOperationError,
			PolicyDeniedError,
			InternalError,
		),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("AppsResume", {
		payload: AppSlugPayload,
		success: AppInstallationView,
		error: Schema.Union(
			AppNotInstalledError,
			AppUnsupportedError,
			AppOperationError,
			PolicyDeniedError,
			InternalError,
		),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("AppsUninstall", {
		payload: AppSlugPayload,
		success: Schema.Struct({ uninstalled: Schema.Boolean }),
		error: Schema.Union(
			AppNotInstalledError,
			AppUnsupportedError,
			AppOperationError,
			PolicyDeniedError,
			InternalError,
		),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("AppsDispatchTest", {
		payload: AppSlugPayload,
		success: Schema.Struct({
			remoteId: Schema.OptionFromNullOr(Schema.String),
		}),
		error: Schema.Union(
			AppNotInstalledError,
			AppUnsupportedError,
			AppSettingsMissingError,
			AppOperationError,
			PolicyDeniedError,
			InternalError,
		),
	}).middleware(RpcAuthMiddleware),
) {}
