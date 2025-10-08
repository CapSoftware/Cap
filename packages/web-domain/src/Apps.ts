import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";

import { RpcAuthMiddleware } from "./Authentication.ts";
import { InternalError } from "./Errors.ts";
import { PolicyDeniedError } from "./Policy.ts";

export const AppType = Schema.Literal("discord");
export type AppType = typeof AppType.Type;

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

export class AppDefinition extends Schema.Class<AppDefinition>(
	"AppDefinition",
)({
	type: AppType,
	displayName: Schema.String,
	description: Schema.String,
	icon: Schema.String,
	category: Schema.String,
	requiredEnvVars: Schema.Array(Schema.String),
	image: Schema.String,
	documentation: Schema.String,
	contentPath: Schema.OptionFromNullOr(Schema.String),
}) {}

export class AppInstallationView extends Schema.Class<AppInstallationView>(
	"AppInstallationView",
)({
	id: Schema.String,
	appType: AppType,
	status: AppStatus,
	organizationId: Schema.String,
	spaceId: Schema.OptionFromNullOr(Schema.String),
	providerDisplayName: Schema.OptionFromNullOr(Schema.String),
	providerMetadata: Schema.OptionFromNullOr(Schema.Unknown),
	lastCheckedAt: Schema.OptionFromNullOr(Schema.Date),
	settings: Schema.OptionFromNullOr(Schema.Unknown),
}) {}

export class AppNotInstalledError extends Schema.TaggedError<
	AppNotInstalledError
>()("AppNotInstalledError", {
	appType: AppType,
}) {}

export class AppUnsupportedError extends Schema.TaggedError<
	AppUnsupportedError
>()("AppUnsupportedError", {
	appType: Schema.String,
}) {}

export class AppSettingsValidationError extends Schema.TaggedError<
	AppSettingsValidationError
>()("AppSettingsValidationError", {
	appType: AppType,
	issues: Schema.Array(Schema.String),
}) {}

export class AppOperationError extends Schema.TaggedError<AppOperationError>()(
	"AppOperationError",
	{
		appType: AppType,
		operation: Schema.String,
		reason: Schema.String,
		retryable: Schema.Boolean,
		status: Schema.OptionFromNullOr(Schema.Number),
	},
) {}

export class AppSettingsMissingError extends Schema.TaggedError<
	AppSettingsMissingError
>()("AppSettingsMissingError", {
	appType: AppType,
}) {}

const AppTypePayload = Schema.Struct({ appType: AppType });

const UpdateSettingsPayload = Schema.Struct({
	appType: AppType,
	settings: Schema.Unknown,
});

export class AppsRpcs extends RpcGroup.make(
	Rpc.make("AppsListDefinitions", {
		payload: Schema.Struct({}),
		success: Schema.Array(AppDefinition),
		error: Schema.Union(PolicyDeniedError, InternalError),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("AppsGetInstallation", {
		payload: AppTypePayload,
		success: Schema.Option(AppInstallationView),
		error: Schema.Union(
			AppUnsupportedError,
			PolicyDeniedError,
			InternalError,
		),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("AppsListDestinations", {
		payload: AppTypePayload,
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
	Rpc.make("AppsPause", {
		payload: AppTypePayload,
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
		payload: AppTypePayload,
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
		payload: AppTypePayload,
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
		payload: AppTypePayload,
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
