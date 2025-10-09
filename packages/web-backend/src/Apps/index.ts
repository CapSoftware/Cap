import type {
	AppDispatchResult,
	AppInstallationRecord,
	AppModule,
	AppDestination as AppModuleDestination,
} from "@cap/apps";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

import {
	type AppHandlerError,
	appsRegistry,
	getAppManifest,
	getAppModuleByName,
	resolveAppAssetPath,
} from "@cap/apps";
import { decrypt } from "@cap/database/crypto";
import type * as Db from "@cap/database/schema";
import {
	Apps as AppsDomain,
	CurrentUser,
	InternalError,
	type Organisation,
	Policy,
} from "@cap/web-domain";
import { Array, Effect, Option, Schema } from "effect";

import type { DatabaseError } from "../Database.ts";
import { OrganisationsPolicy } from "../Organisations/OrganisationsPolicy.ts";

import { AppInstallationSettingsRepo } from "./AppInstallationSettingsRepo.ts";
import { AppInstallationsRepo } from "./AppInstallationsRepo.ts";

type AppInstallationRow = typeof Db.appInstallations.$inferSelect;
type AppInstallationSettingsRow =
	typeof Db.appInstallationSettings.$inferSelect;

const formatValidationIssues = (error: unknown) =>
	error instanceof Error ? error.message : "Invalid settings";

const parseAppSlug = (value: string): AppsDomain.AppSlug =>
	Schema.decodeUnknownSync(AppsDomain.AppSlug)(value);
const decodeAppInstallationView = Schema.decodeUnknown(
	AppsDomain.AppInstallationView,
);
const decodeAppDestination = Schema.decodeUnknown(AppsDomain.AppDestination);

const toSettingsSchema = (schema: Schema.Schema.All) =>
	schema as Schema.Schema<unknown, unknown, never>;

const toSettingsRecord = (value: unknown) =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? Effect.succeed(value as Record<string, unknown>)
		: Effect.fail(new InternalError({ type: "unknown" }));

const toOperationError = (slug: string, error: AppHandlerError) =>
	new AppsDomain.AppOperationError({
		slug: parseAppSlug(slug),
		operation: error.operation,
		reason: error.reason,
		retryable: error.retryable,
		status: Option.fromNullable(error.status),
	});

type RuntimeAppManifest = ReturnType<typeof getAppManifest> & {
	readonly publisher?: { readonly name: string; readonly email: string };
	readonly contentPath?: string | null;
	readonly image?: string | null;
	readonly documentation?: string | null;
};

type AnyAppModule = AppModule<AppsDomain.AppSlug, unknown, unknown> & {
	readonly slug: AppsDomain.AppSlug;
	readonly definition: AppModule<
		AppsDomain.AppSlug,
		unknown,
		unknown
	>["definition"] & { readonly slug: AppsDomain.AppSlug };
};

type RuntimeAppInstallationRecord = AppInstallationRecord<AppsDomain.AppSlug> & {
	readonly slug: AppsDomain.AppSlug;
	readonly appType: AppsDomain.AppSlug;
};
type BaseAppErrors =
	| AppsDomain.AppNotInstalledError
	| AppsDomain.AppUnsupportedError
	| AppsDomain.AppOperationError
	| InternalError
	| Policy.PolicyDeniedError;
type InstallationHandlerContext = {
	module: AnyAppModule;
	installation: AppInstallationRow;
	settings: Option.Option<unknown>;
	credentials: Option.Option<{
		accessToken: string;
		refreshToken: string | null;
		scope: string | null;
		expiresAt: Date | null;
	}>;
	user: CurrentUser["Type"];
};

const mapDatabaseError = <A, R>(effect: Effect.Effect<A, DatabaseError, R>) =>
	effect.pipe(Effect.mapError(() => new InternalError({ type: "database" })));

const readTextAsset = (
	appSlug: string,
	assetPath: string | undefined,
): string | null => {
	if (!assetPath) return null;
	const resolvedPath = resolveAppAssetPath(appSlug, assetPath);
	if (!resolvedPath) return null;
	try {
		return readFileSync(resolvedPath, "utf8");
	} catch {
		return null;
	}
};

const determineMimeType = (assetPath: string): string => {
	switch (extname(assetPath).toLowerCase()) {
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		default:
			return "application/octet-stream";
	}
};

const readImageAsset = (
	appSlug: string,
	assetPath: string | undefined,
): string | null => {
	if (!assetPath) return null;
	const resolvedPath = resolveAppAssetPath(appSlug, assetPath);
	if (!resolvedPath) return null;
	try {
		const buffer = readFileSync(resolvedPath);
		const mimeType = determineMimeType(resolvedPath);
		return `data:${mimeType};base64,${buffer.toString("base64")}`;
	} catch {
		return null;
	}
};

const toDefinition = (module: AppModule<string, unknown, unknown>) => {
	const runtimeModule = module as AnyAppModule;
	const manifest = getAppManifest(runtimeModule.slug) as RuntimeAppManifest;

	if (!manifest) {
		throw new InternalError({ type: "unknown" });
	}

	if (!manifest.publisher) {
		throw new InternalError({ type: "unknown" });
	}

	const appSlug = parseAppSlug(runtimeModule.slug);
	const content = readTextAsset(
		runtimeModule.slug,
		manifest.contentPath ?? undefined,
	) ?? "";
	const image =
		readImageAsset(runtimeModule.slug, manifest.image ?? undefined) ??
		manifest.image ??
		"";

	return new AppsDomain.AppDefinition({
		slug: appSlug,
		displayName: runtimeModule.definition.displayName,
		description: runtimeModule.definition.description,
		icon: runtimeModule.definition.icon,
		category: runtimeModule.definition.category,
		requiredEnvVars: manifest.requiredEnvVars ?? [],
		image,
		documentation: manifest.documentation ?? "",
		content,
		contentPath: Option.fromNullable(manifest.contentPath ?? null),
		publisher: manifest.publisher,
	});
};

const toInstallationRecord = (
	row: AppInstallationRow,
): RuntimeAppInstallationRecord => {
	const slug = parseAppSlug(row.appType);

	return {
		id: row.id,
		organizationId: row.organizationId,
		spaceId: row.spaceId,
		appType: slug,
		slug,
		status: row.status,
		providerExternalId: row.providerExternalId,
		providerDisplayName: row.providerDisplayName,
		providerMetadata: row.providerMetadata,
	};
};

const encodeSettings = (
	schema: Schema.Schema.All,
	value: unknown,
) =>
	Schema.encode(toSettingsSchema(schema))(value).pipe(
		Effect.mapError(() => new InternalError({ type: "unknown" })),
	);

const decodeSettings = (
	schema: Schema.Schema.All,
	row: Option.Option<AppInstallationSettingsRow>,
) =>
	Option.match(row, {
		onNone: () => Effect.succeed<Option.Option<unknown>>(Option.none<unknown>()),
		onSome: (stored) =>
			Schema.decodeUnknown(toSettingsSchema(schema))(stored.settings).pipe(
				Effect.map((value) => Option.some(value)),
				Effect.catchAll((error) =>
					Effect.logWarning(
						`Failed to decode app settings: ${formatValidationIssues(error)}`,
					).pipe(Effect.as(Option.none<unknown>())),
				),
			),
	});

const extractSpaceId = (settings: unknown) => {
	if (typeof settings !== "object" || settings === null) {
		return undefined;
	}

	const candidate = (settings as { spaceId?: unknown }).spaceId;

	if (typeof candidate !== "string") {
		return undefined;
	}

	const trimmed = candidate.trim();

	return trimmed.length > 0 ? trimmed : undefined;
};

const buildView = (
	module: AnyAppModule,
	installation: AppInstallationRow,
	settings: Option.Option<unknown>,
) =>
	Effect.gen(function* () {
		const encodedSettings = yield* Option.match(settings, {
			onNone: () => Effect.succeed<null>(null),
			onSome: (value) =>
				encodeSettings(module.definition.settings.schema, value),
		});

		return yield* decodeAppInstallationView({
			id: installation.id,
			slug: module.slug,
			status: installation.status,
			organizationId: installation.organizationId,
			spaceId: installation.spaceId,
			providerDisplayName: installation.providerDisplayName,
			providerMetadata: installation.providerMetadata ?? null,
			lastCheckedAt: installation.lastCheckedAt ?? null,
			settings: encodedSettings,
		}).pipe(Effect.mapError(() => new InternalError({ type: "unknown" })));
	});

const decryptToken = (value: string | null | undefined) =>
	Option.fromNullable(value).pipe(
		Option.match({
			onNone: () => Effect.succeed<null>(null),
			onSome: (token) =>
				Effect.tryPromise({
					try: () => decrypt(token),
					catch: () => new InternalError({ type: "unknown" }),
				}).pipe(Effect.map((result) => result)),
		}),
	);

const loadCredentials = (installation: AppInstallationRow) =>
	Effect.gen(function* () {
		const accessToken = yield* Effect.tryPromise({
			try: () => decrypt(installation.accessToken),
			catch: () => new InternalError({ type: "unknown" }),
		});

		const refreshToken = yield* decryptToken(installation.refreshToken);
		const scope = yield* decryptToken(installation.scope);

		return {
			accessToken,
			refreshToken,
			scope,
			expiresAt: installation.expiresAt ?? null,
		};
	});

const mapHandlerError = <A>(
	module: AnyAppModule,
	effect: Effect.Effect<A, AppHandlerError>,
) =>
	effect.pipe(
		Effect.catchAll((error: AppHandlerError) =>
			Effect.fail(toOperationError(module.slug, error)),
		),
	);

export class Apps extends Effect.Service<Apps>()("Apps", {
	effect: Effect.gen(function* () {
		const installationsRepo = yield* AppInstallationsRepo;
		const settingsRepo = yield* AppInstallationSettingsRepo;
		const organisationsPolicy = yield* OrganisationsPolicy;

		const listDefinitions: () => Effect.Effect<
			ReadonlyArray<AppsDomain.AppDefinition>,
			never
		> = () => Effect.sync(() => Object.values(appsRegistry).map(toDefinition));

		const ensureOwner = (orgId: Organisation.OrganisationId) =>
			organisationsPolicy.isOwner(orgId).pipe(
				Effect.catchTag(
					"DatabaseError",
					() => new InternalError({ type: "database" }),
				),
				Effect.catchTag("PolicyDenied", () => new Policy.PolicyDeniedError()),
			);

		const lookupModule = (
			slug: string,
		): Effect.Effect<AnyAppModule, AppsDomain.AppUnsupportedError> =>
			Effect.sync(() => Option.fromNullable(getAppModuleByName(slug))).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => new AppsDomain.AppUnsupportedError({ slug }),
						onSome: (module) =>
							Effect.try({
								try: () => {
									const typedModule = module as AnyAppModule;
									parseAppSlug(typedModule.slug);
									return typedModule;
								},
								catch: () => new AppsDomain.AppUnsupportedError({ slug }),
							}),
					}),
				),
			);

		const getInstallation = (
			slug: string,
		): Effect.Effect<
			Option.Option<AppsDomain.AppInstallationView>,
			AppsDomain.AppUnsupportedError | Policy.PolicyDeniedError | InternalError,
			CurrentUser
		> =>
			Effect.gen(function* () {
				const user = yield* CurrentUser;
				yield* ensureOwner(user.activeOrganizationId);
				const module = yield* lookupModule(slug);

				const installationOption = yield* mapDatabaseError(
					installationsRepo.findByOrgAndSlug(
						user.activeOrganizationId,
						module.slug,
					),
				);

				if (Option.isNone(installationOption)) {
					return Option.none<AppsDomain.AppInstallationView>();
				}

				const settingsRow = yield* mapDatabaseError(
					settingsRepo.findByInstallationId(installationOption.value.id),
				);
				const decodedSettings = yield* decodeSettings(
					module.definition.settings.schema,
					settingsRow,
				);

				const view = yield* buildView(
					module,
					installationOption.value,
					decodedSettings,
				);
				return Option.some(view);
			});

		function withInstallation<A, E = never>(
			slug: string,
			handler: (
				context: InstallationHandlerContext,
			) => Effect.Effect<A, BaseAppErrors | E>,
		): Effect.Effect<A, BaseAppErrors | E, CurrentUser>;
		function withInstallation<A, E = never>(
			slug: string,
			options: { requireSettings: true },
			handler: (
				context: InstallationHandlerContext,
			) => Effect.Effect<
				A,
				BaseAppErrors | AppsDomain.AppSettingsMissingError | E
			>,
		): Effect.Effect<
			A,
			BaseAppErrors | AppsDomain.AppSettingsMissingError | E,
			CurrentUser
		>;
		function withInstallation<A, E = never>(
			slug: string,
			optionsOrHandler:
				| { requireSettings: true }
				| ((
						context: InstallationHandlerContext,
				  ) => Effect.Effect<A, BaseAppErrors | E>),
			maybeHandler?: (
				context: InstallationHandlerContext,
			) => Effect.Effect<
				A,
				BaseAppErrors | AppsDomain.AppSettingsMissingError | E
			>,
		): Effect.Effect<
			A,
			BaseAppErrors | AppsDomain.AppSettingsMissingError | E,
			CurrentUser
		> {
			const options =
				typeof optionsOrHandler === "function" ? undefined : optionsOrHandler;
			const handler = (
				typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler
			) as (
				context: InstallationHandlerContext,
			) => Effect.Effect<
				A,
				BaseAppErrors | AppsDomain.AppSettingsMissingError | E
			>;
			const requireSettings = options?.requireSettings === true;

			return Effect.gen(function* () {
				const user = yield* CurrentUser;
				yield* ensureOwner(user.activeOrganizationId);
				const module = yield* lookupModule(slug);

				const installationOption = yield* mapDatabaseError(
					installationsRepo.findByOrgAndSlug(
						user.activeOrganizationId,
						module.slug,
					),
				);

				if (Option.isNone(installationOption)) {
					return yield* Effect.fail(
						new AppsDomain.AppNotInstalledError({ slug: module.slug }),
					);
				}

				const installation = installationOption.value;
				const settingsRow = yield* mapDatabaseError(
					settingsRepo.findByInstallationId(installation.id),
				);
				const decodedSettings = yield* decodeSettings(
					module.definition.settings.schema,
					settingsRow,
				);

				if (requireSettings && Option.isNone(decodedSettings)) {
					return yield* Effect.fail(
						new AppsDomain.AppSettingsMissingError({ slug: module.slug }),
					);
				}

				const credentialsOption = yield* loadCredentials(installation).pipe(
					Effect.map((credentials) => Option.some(credentials)),
				);

				return yield* handler({
					module,
					installation,
					settings: decodedSettings,
					credentials: credentialsOption,
					user,
				});
			});
		}

		const listDestinations = (
			slug: string,
		): Effect.Effect<
			ReadonlyArray<AppsDomain.AppDestination>,
			| AppsDomain.AppNotInstalledError
			| AppsDomain.AppUnsupportedError
			| AppsDomain.AppOperationError
			| InternalError
			| Policy.PolicyDeniedError,
			CurrentUser
		> =>
			withInstallation(
				slug,
				({ module, installation, settings, credentials }) => {
					return mapHandlerError(
						module,
						module.handlers.listDestinations({
							installation: toInstallationRecord(installation),
							credentials: Option.getOrNull(credentials),
							settings: Option.getOrNull(settings),
						}),
					).pipe(
						Effect.flatMap((destinations) =>
							Effect.forEach(
								destinations,
								(destination: AppModuleDestination) =>
									decodeAppDestination({
										id: destination.id,
										name: destination.name,
										type: destination.type,
										parentId: destination.parentId ?? null,
									}).pipe(
										Effect.mapError(
											() => new InternalError({ type: "unknown" }),
										),
									),
							),
						),
					);
				},
			);

		const updateSettings = (
			slug: string,
			rawSettings: unknown,
		): Effect.Effect<
			AppsDomain.AppInstallationView,
			| AppsDomain.AppNotInstalledError
			| AppsDomain.AppUnsupportedError
			| AppsDomain.AppSettingsValidationError
			| AppsDomain.AppOperationError
			| InternalError
			| Policy.PolicyDeniedError,
			CurrentUser
		> =>
			withInstallation(slug, ({ module, installation, user }) =>
				Effect.gen(function* () {
				const settingsSchema = module.definition.settings.schema;

				const settingsValue = yield* Schema.decodeUnknown(
					toSettingsSchema(settingsSchema),
				)(rawSettings).pipe(
						Effect.mapError(
							(error) =>
								new AppsDomain.AppSettingsValidationError({
									slug: module.slug,
									issues: [formatValidationIssues(error)],
								}),
						),
					);

					const persistable = yield* encodeSettings(
						settingsSchema,
						settingsValue,
					);
					const record = yield* toSettingsRecord(persistable);
					yield* mapDatabaseError(settingsRepo.upsert(installation.id, record));

					const nextSpaceId = extractSpaceId(settingsValue);
					const updatedAt = new Date();

					yield* mapDatabaseError(
						installationsRepo.updateById(installation.id, {
							status: "connected",
							updatedByUserId: user.id,
							lastCheckedAt: updatedAt,
							...(nextSpaceId !== undefined ? { spaceId: nextSpaceId } : {}),
						}),
					);

					return yield* buildView(
						module,
						{
							...installation,
							status: "connected",
							spaceId: nextSpaceId ?? installation.spaceId,
							lastCheckedAt: updatedAt,
						},
						Option.some(settingsValue),
					);
				}),
			);

		const pause = (
			slug: string,
		): Effect.Effect<
			AppsDomain.AppInstallationView,
			| AppsDomain.AppNotInstalledError
			| AppsDomain.AppUnsupportedError
			| AppsDomain.AppOperationError
			| InternalError
			| Policy.PolicyDeniedError,
			CurrentUser
		> =>
			withInstallation(
				slug,
				({ module, installation, settings, credentials, user }) =>
					mapHandlerError(
						module,
						module.handlers.pause({
							installation: toInstallationRecord(installation),
							credentials: Option.getOrNull(credentials),
							settings: Option.getOrNull(settings),
						}),
					).pipe(
						Effect.tap(() =>
							mapDatabaseError(
								installationsRepo.updateById(installation.id, {
									status: "paused",
									updatedByUserId: user.id,
								}),
							),
						),
						Effect.flatMap(() => buildView(module, installation, settings)),
					),
			);

		const resume = (
			slug: string,
		): Effect.Effect<
			AppsDomain.AppInstallationView,
			| AppsDomain.AppNotInstalledError
			| AppsDomain.AppUnsupportedError
			| AppsDomain.AppOperationError
			| InternalError
			| Policy.PolicyDeniedError,
			CurrentUser
		> =>
			withInstallation(
				slug,
				({ module, installation, settings, credentials, user }) =>
					mapHandlerError(
						module,
						module.handlers.resume({
							installation: toInstallationRecord(installation),
							credentials: Option.getOrNull(credentials),
							settings: Option.getOrNull(settings),
						}),
					).pipe(
						Effect.tap(() =>
							mapDatabaseError(
								installationsRepo.updateById(installation.id, {
									status: "connected",
									updatedByUserId: user.id,
									lastCheckedAt: new Date(),
								}),
							),
						),
						Effect.flatMap(() => buildView(module, installation, settings)),
					),
			);

		const uninstall = (
			slug: string,
		): Effect.Effect<
			{ uninstalled: boolean },
			| AppsDomain.AppNotInstalledError
			| AppsDomain.AppUnsupportedError
			| AppsDomain.AppOperationError
			| InternalError
			| Policy.PolicyDeniedError,
			CurrentUser
		> =>
			withInstallation(
				slug,
				({ module, installation, settings, credentials }) =>
					mapHandlerError(
						module,
						module.handlers.uninstall({
							installation: toInstallationRecord(installation),
							credentials: Option.getOrNull(credentials),
							settings: Option.getOrNull(settings),
						}),
					).pipe(
						Effect.tap(() =>
							mapDatabaseError(
								settingsRepo.deleteByInstallationId(installation.id),
							),
						),
						Effect.tap(() =>
							mapDatabaseError(installationsRepo.deleteById(installation.id)),
						),
						Effect.as({ uninstalled: true }),
					),
			);

		const buildTestPayload = (
			module: AnyAppModule,
		): Effect.Effect<unknown, InternalError> =>
			Effect.succeed({
				type: "video.published",
				videoId: "test",
				videoTitle: `Test notification from ${module.definition.displayName}`,
				videoDescription:
					"This is a test notification from Cap to confirm your integration is reachable.",
				videoUrl: "https://cap.so",
				spaceName: "Test space",
				organizationName: "Cap",
				authorName: "Cap Bot",
				authorAvatarUrl: null,
			});

		const dispatchTest = (
			slug: string,
		): Effect.Effect<
			{ remoteId: Option.Option<string> },
			| AppsDomain.AppNotInstalledError
			| AppsDomain.AppUnsupportedError
			| AppsDomain.AppSettingsMissingError
			| AppsDomain.AppOperationError
			| InternalError
			| Policy.PolicyDeniedError,
			CurrentUser
		> =>
			withInstallation(
				slug,
				{ requireSettings: true },
				({ module, installation, settings, credentials }) => {
					return Option.match(settings, {
						onNone: () =>
							Effect.fail(
								new AppsDomain.AppSettingsMissingError({
									slug: module.slug,
								}),
							),
						onSome: (settingsValue) =>
							buildTestPayload(module).pipe(
								Effect.flatMap((payload) =>
									mapHandlerError(
										module,
										module.handlers.dispatch({
											installation: toInstallationRecord(installation),
											credentials: Option.getOrNull(credentials),
											settings: settingsValue,
											payload,
										}),
									).pipe(
										Effect.map((result: AppDispatchResult) => ({
											remoteId: Option.fromNullable(result.remoteId),
										})),
									),
								),
							),
					});
				},
			);

		return {
			listDefinitions,
			getInstallation,
			listDestinations,
			updateSettings,
			pause,
			resume,
			uninstall,
			dispatchTest,
		};
	}),
	dependencies: [
		AppInstallationsRepo.Default,
		AppInstallationSettingsRepo.Default,
		OrganisationsPolicy.Default,
	],
}) {}
