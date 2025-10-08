import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";

import { createAppRegistry } from "./core/app.ts";
import { createAppStateHandlers } from "./core/state.ts";
import type { AppManifest } from "./core/manifest.ts";
import { AppManifestSchema, DEFAULT_INSTALL_MODULE } from "./core/manifest.ts";
import type { AppModule } from "./core/types.ts";
import type { AppStatePayload } from "./core/state.ts";
import { createApp as createDiscordApp } from "./discord/install.ts";

export type {
  AppAuthorizeContext,
  AppCallbackContext,
  AppCredentials,
  AppDefinition,
  AppDestination,
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
export type { AppStatePayload } from "./core/state.ts";
export { AppStateError } from "./core/state.ts";
export { AppHandlerError, createAppHandlerError } from "./core/errors.ts";
export type { AppHandlerErrorInput } from "./core/errors.ts";
export {
  DISCORD_APP_TYPE as DISCORD_APP_TYPE,
  DiscordAppSettings,
  buildDiscordMessage,
  discordDefinition,
  discordManifest,
} from "./discord/config.ts";
export type {
  DiscordAppSettings as DiscordAppSettingsType,
  DiscordDispatchPayload,
} from "./discord/config.ts";

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

const resolveAppsDirectoryPath = (): string => {
  // Next's bundler may emit virtual URLs; fall back to workspace paths when no file:// scheme is present.
  const importMetaUrl = import.meta.url;

  if (typeof importMetaUrl === "string" && importMetaUrl.startsWith("file://")) {
    return fileURLToPath(new URL("./", importMetaUrl));
  }

  const fallbackRoots: string[] = [];
  let currentRoot = process.cwd();

  for (let depth = 0; depth < 5; depth += 1) {
    fallbackRoots.push(currentRoot);
    currentRoot = resolve(currentRoot, "..");
  }

  for (const root of fallbackRoots) {
    const candidate = join(root, "packages", "apps", "src");
    if (existsSync(candidate)) return candidate;
  }

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

  const normalizedInstallModule = normalizeInstallModuleSpecifier(installModule);

  if (!registration.moduleSpecifiers.has(normalizedInstallModule)) {
    throw new Error(
      `Unsupported install module '${installModule}' for app directory '${directory}'. ` +
        `Expected one of: ${Array.from(registration.moduleSpecifiers).join(", ")}.`,
    );
  }

  return registration.factory;
};

const discoveredApps = await (async (): Promise<ReadonlyArray<DiscoveredApp>> => {
  const directories = readdirSync(appsDirectoryPath, { withFileTypes: true });
  const seenTypes = new Set<string>();
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

    if (seenTypes.has(manifest.type)) {
      throw new Error(
        `Duplicate app type '${manifest.type}' detected while loading ${manifestPath}`,
      );
    }
    seenTypes.add(manifest.type);

    const factory = resolveModuleFactory(entry.name, manifest.installModule);

    results.push({
      manifest: Object.freeze(manifest),
      factory: factory as ModuleFactory,
    });
  }

  return results;
})();

const manifestEntries = discoveredApps.map((entry) => [
  entry.manifest.type,
  entry.manifest,
]) as ReadonlyArray<readonly [string, DiscoveredApp["manifest"]]>;

const manifestMap = Object.freeze(
  Object.fromEntries(manifestEntries),
) as Readonly<Record<string, DiscoveredApp["manifest"]>>;

const moduleTypes = new Set(Object.keys(manifestMap));

const { encodeAppState, decodeAppState } = createAppStateHandlers<string>(
  (value: string): value is string => moduleTypes.has(value),
);

const modulesEntries = discoveredApps.map((entry) => [
  entry.manifest.type,
  entry.factory({ encodeAppState }),
]) as ReadonlyArray<readonly [string, AppModule<string, unknown, unknown>]>;

const modules = Object.freeze(Object.fromEntries(modulesEntries)) as Readonly<
  Record<string, AppModule<string, unknown, unknown>>
>;

const registry = createAppRegistry(modules);

export const APP_TYPES = registry.appTypes;
export type AppType = (typeof APP_TYPES)[number];

export const isAppType = registry.isAppType;
export const appsRegistry = registry.modules;
export const getAppModule = registry.getAppModule;
export const getAppModuleByName = registry.getAppModuleByName;

export const appManifests = manifestMap;

export const getAppManifest = (appType: string) => manifestMap[appType];

const requiredEnvVarsByAppEntries = manifestEntries.map(([type, manifest]) => [
  type,
  manifest.requiredEnvVars,
]) as ReadonlyArray<readonly [string, ReadonlyArray<string>]>;

export const requiredEnvVarsByApp = Object.freeze(
  Object.fromEntries(requiredEnvVarsByAppEntries),
) as Readonly<Record<string, ReadonlyArray<string>>>;

export const allRequiredEnvVars = Object.freeze(
  Array.from(
    new Set(
      requiredEnvVarsByAppEntries.flatMap(([, envVars]) => envVars),
    ),
  ),
) as ReadonlyArray<string>;

export const getRequiredEnvVarsForApp = (appType: string) =>
  requiredEnvVarsByApp[appType] ?? [];

export { encodeAppState, decodeAppState };
