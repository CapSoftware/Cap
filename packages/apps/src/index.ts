import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { createAppRegistry } from "./core/app.ts";
import {
	registerAppDirectory,
	registerAppEnvRequirements,
} from "./core/app-env.ts";
import type { AppManifest } from "./core/manifest.ts";
import { AppManifestSchema, DEFAULT_INSTALL_MODULE } from "./core/manifest.ts";
import type { AppStatePayload } from "./core/state.ts";
import { createAppStateHandlers } from "./core/state.ts";
import type { AppModule } from "./core/types.ts";
import { createApp as createDiscordApp } from "./discord/install.ts";

export type { AppHandlerErrorInput } from "./core/errors.ts";
export { AppHandlerError, createAppHandlerError } from "./core/errors.ts";
export type { AppStatePayload } from "./core/state.ts";
export { AppStateError } from "./core/state.ts";
export type {
	OAuthAppHandlers,
	OAuthAppOptions,
	OAuthHandlerDependencies,
	OAuthTokenSet,
} from "./core/templates/oauth-app.ts";
export {
	createOAuthAppModule,
	OAuthCallbackError,
	OAuthConfigError,
	OAuthPermissionError,
	OAuthProviderError,
} from "./core/templates/oauth-app.ts";
export type {
	AppAuthorizeContext,
	AppCallbackContext,
	AppCredentials,
	AppDefinition,
	AppDestination,
	AppDestinationVerificationResult,
	AppDispatchContext,
	AppDispatchResult,
	AppInstallationRecord,
	AppInstallationRepoCreate,
	AppInstallationRepoRecord,
	AppInstallationRepoUpdate,
	AppInstallationsRepository,
	AppModule,
	AppOAuthHandlers,
	AppOperationContext,
	AppRefreshContext,
	OrganisationsPolicyInstance,
} from "./core/types.ts";
export type {
	DiscordAppSettings as DiscordAppSettingsType,
	DiscordAppSlug,
	DiscordDispatchPayload,
} from "./discord/install.ts";
export {
	buildDiscordMessage,
	DiscordAppSettings,
	discordDefinition,
	discordManifest,
} from "./discord/install.ts";

export type ModuleFactoryDependencies = {
	encodeAppState: (payload: AppStatePayload<string>) => string;
};

type ModuleFactory = (
	dependencies: ModuleFactoryDependencies,
) => AppModule<string, unknown, unknown>;

type DiscoveredApp = {
	manifest: Readonly<
		AppManifest & {
			installModule: string;
			requiredEnvVars: ReadonlyArray<string>;
		}
	>;
	factory: ModuleFactory;
};

const APPS_DIRECTORY_SEGMENTS = ["packages", "apps", "src"] as const;
const APP_DIRECTORY_MAX_ASCENT = 10;

const isAppsDirectory = (candidate: string): boolean =>
	existsSync(candidate) && existsSync(join(candidate, "index.ts"));

const locateAppsDirectoryFrom = (start: string): string | undefined => {
	let current = resolve(start);

	for (let depth = 0; depth < APP_DIRECTORY_MAX_ASCENT; depth += 1) {
		if (isAppsDirectory(current)) return current;

		const joined = join(current, ...APPS_DIRECTORY_SEGMENTS);
		if (isAppsDirectory(joined)) return joined;

		const parent = resolve(current, "..");
		if (parent === current) break;
		current = parent;
	}

	return undefined;
};

const resolveAppsDirectoryPath = (): string => {
	const importMetaUrl = import.meta.url;

	if (typeof importMetaUrl === "string" && importMetaUrl.startsWith("file://")) {
		const importDirectory = fileURLToPath(new URL("./", importMetaUrl));
		const locatedFromImport = locateAppsDirectoryFrom(importDirectory);
		if (locatedFromImport) return locatedFromImport;
	}

	const locatedFromCwd = locateAppsDirectoryFrom(process.cwd());
	if (locatedFromCwd) return locatedFromCwd;

	throw new Error(
		`Unable to resolve apps directory path from import.meta.url (received ${importMetaUrl})`,
	);
};

const appsDirectoryPath = resolveAppsDirectoryPath();

const normalizeInstallModuleSpecifier = (specifier: string): string =>
	specifier.replace(/^\.\//, "").replace(/\\/g, "/");

type ModuleRegistration = {
	readonly moduleSpecifiers: ReadonlySet<string>;
	readonly factory: ModuleFactory;
};

const moduleRegistrations = new Map<string, ModuleRegistration>([
	[
		"discord",
		{
			moduleSpecifiers: new Set([
				normalizeInstallModuleSpecifier(DEFAULT_INSTALL_MODULE),
			]),
			factory: (dependencies) =>
				createDiscordApp(dependencies) as AppModule<string, unknown, unknown>,
		},
	],
]);

const appSourceDirectories = new Map<string, string>();
const appDistDirectories = new Map<string, string>();

const resolveModuleFactory = (
	directory: string,
	installModule: string,
): ModuleFactory => {
	const registration = moduleRegistrations.get(directory);

	if (!registration) {
		throw new Error(
			`No module factory registered for app directory '${directory}'. ` +
				"Add a registration to moduleRegistrations in packages/apps/src/index.ts.",
		);
	}

	const normalizedInstallModule =
		normalizeInstallModuleSpecifier(installModule);

	if (!registration.moduleSpecifiers.has(normalizedInstallModule)) {
		throw new Error(
			`Unsupported install module '${installModule}' for app directory '${directory}'. ` +
				`Expected one of: ${Array.from(registration.moduleSpecifiers).join(", ")}.`,
		);
	}

	return registration.factory;
};

const discoveredApps = await (async (): Promise<
	ReadonlyArray<DiscoveredApp>
> => {
	const directories = readdirSync(appsDirectoryPath, { withFileTypes: true });
	const seenSlugs = new Set<string>();
	const results: DiscoveredApp[] = [];

	for (const entry of directories) {
		if (!entry.isDirectory() || entry.name === "core") continue;

		const manifestPath = join(appsDirectoryPath, entry.name, "config.json");

		if (!existsSync(manifestPath)) continue;

		const manifestRaw = JSON.parse(readFileSync(manifestPath, "utf8"));

		let manifest: AppManifest & {
			installModule: string;
			requiredEnvVars: ReadonlyArray<string>;
		};

		try {
			manifest = Effect.runSync(
				Schema.decodeUnknown(AppManifestSchema)(manifestRaw).pipe(
					Effect.map((decoded) => ({
						...decoded,
						installModule: decoded.installModule ?? DEFAULT_INSTALL_MODULE,
						requiredEnvVars: Object.freeze(
							Array.from(new Set(decoded.requiredEnvVars)),
						),
					})),
				),
			);
		} catch (cause) {
			throw new Error(
				`Invalid manifest at ${manifestPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
			);
		}

		if (seenSlugs.has(manifest.slug)) {
			throw new Error(
				`Duplicate app slug '${manifest.slug}' detected while loading ${manifestPath}`,
			);
		}
		seenSlugs.add(manifest.slug);

		const manifestDirectory = dirname(manifestPath);
		registerAppDirectory(manifestDirectory, manifest.slug);
		appSourceDirectories.set(manifest.slug, manifestDirectory);

		const distDirectory = join(appsDirectoryPath, "..", "dist", entry.name);
		registerAppDirectory(distDirectory, manifest.slug);
		appDistDirectories.set(manifest.slug, distDirectory);

		const factory = resolveModuleFactory(entry.name, manifest.installModule);

		results.push({
			manifest: Object.freeze(manifest),
			factory: factory as ModuleFactory,
		});
	}

	return results;
})();

const manifestEntries = discoveredApps.map((entry) => [
	entry.manifest.slug,
	entry.manifest,
]) as ReadonlyArray<readonly [string, DiscoveredApp["manifest"]]>;

const manifestMap = Object.freeze(
	Object.fromEntries(manifestEntries),
) as Readonly<Record<string, DiscoveredApp["manifest"]>>;

const resolveAssetPath = (
	baseDirectory: string | undefined,
	assetPath: string,
): string | undefined => {
	if (!baseDirectory) return undefined;
	if (!assetPath || assetPath.startsWith("/") || /^[a-zA-Z]+:/.test(assetPath)) {
		return undefined;
	}

	const normalizedBase = resolve(baseDirectory);
	const resolvedAssetPath = resolve(normalizedBase, assetPath);
	const isWithinBase =
		resolvedAssetPath === normalizedBase ||
		resolvedAssetPath.startsWith(`${normalizedBase}${sep}`);

	if (!isWithinBase) return undefined;
	if (!existsSync(resolvedAssetPath)) return undefined;
	return resolvedAssetPath;
};

export const resolveAppAssetPath = (
	appSlug: string,
	assetPath: string,
): string | undefined => {
	const fromSource = resolveAssetPath(
		appSourceDirectories.get(appSlug),
		assetPath,
	);
	if (fromSource) return fromSource;

	return resolveAssetPath(appDistDirectories.get(appSlug), assetPath);
};

const moduleSlugs = new Set(Object.keys(manifestMap));

const { encodeAppState, decodeAppState } = createAppStateHandlers<string>(
	(value: string): value is string => moduleSlugs.has(value),
);

const modulesEntries = discoveredApps.map((entry) => [
	entry.manifest.slug,
	entry.factory({ encodeAppState }),
]) as ReadonlyArray<readonly [string, AppModule<string, unknown, unknown>]>;

const modules = Object.freeze(Object.fromEntries(modulesEntries)) as Readonly<
	Record<string, AppModule<string, unknown, unknown>>
>;

const registry = createAppRegistry(modules);

export const APP_SLUGS = registry.appSlugs;
export type AppSlug = (typeof APP_SLUGS)[number];

export const isAppSlug = registry.isAppSlug;
export const appsRegistry = registry.modules;
export const getAppModule = registry.getAppModule;
export const getAppModuleByName = registry.getAppModuleByName;

export const appManifests = manifestMap;

export const getAppManifest = (appSlug: string) => manifestMap[appSlug];

const requiredEnvVarsByAppEntries = manifestEntries.map(([slug, manifest]) => [
	slug,
	manifest.requiredEnvVars,
]) as ReadonlyArray<readonly [string, ReadonlyArray<string>]>;

export const requiredEnvVarsByApp = Object.freeze(
	Object.fromEntries(requiredEnvVarsByAppEntries),
) as Readonly<Record<string, ReadonlyArray<string>>>;

registerAppEnvRequirements(requiredEnvVarsByApp);

export const allRequiredEnvVars = Object.freeze(
	Array.from(
		new Set(requiredEnvVarsByAppEntries.flatMap(([, envVars]) => envVars)),
	),
) as ReadonlyArray<string>;

export const getRequiredEnvVarsForApp = (appSlug: string) =>
	requiredEnvVarsByApp[appSlug] ?? [];

export { encodeAppState, decodeAppState };
export {
	getAppEnvVars,
	getAppEnvVarsForModule,
	getAppSlugForModule,
	getServerEnv,
} from "./core/app-env.ts";
export { createAppModuleContext } from "./core/module-context.ts";
export {
	generateCodeChallenge,
	generateCodeVerifier,
	generatePkcePair,
} from "./core/oauth/pkce.ts";
export {
	createOAuthSessionManager,
	type OAuthSessionData,
	type OAuthSessionManager,
	type OAuthSessionOptions,
} from "./core/oauth/session.ts";
export {
	ensureOrganisationMember,
	ensureOrganisationOwner,
	isPolicyDeniedError,
} from "./core/policy.ts";
