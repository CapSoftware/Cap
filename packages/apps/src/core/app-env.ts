import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { serverEnv } from "@cap/env/server";

export type AppEnvRequirements = Readonly<
	Record<string, ReadonlyArray<string>>
>;

let requirements: AppEnvRequirements | undefined;
let hasValidated = false;
const appDirectoryToSlug = new Map<string, string>();

const isServerRuntime = () =>
	typeof process !== "undefined" && typeof process.env === "object";

const isMissingEnvValue = (value: unknown) =>
	value == null || (typeof value === "string" && value.trim().length === 0);

const ensureRequirementsRegistered = () => {
	if (!requirements) {
		throw new Error(
			"App environment requirements have not been registered. Import '@cap/apps' before accessing getAppEnvVars().",
		);
	}
};

const assertRequiredEnvVars = (env: Readonly<Record<string, unknown>>) => {
	ensureRequirementsRegistered();

	const missingByApp: string[] = [];

	for (const [type, envVars] of Object.entries(requirements!)) {
		if (envVars.length === 0) continue;

		const missing = envVars.filter((key) => isMissingEnvValue(env[key]));

		if (missing.length > 0) {
			missingByApp.push(`${type}: ${missing.join(", ")}`);
		}
	}

	if (missingByApp.length > 0) {
		throw new Error(
			`Missing environment variables for app integrations:\n${missingByApp.join("\n")}`,
		);
	}
};

const ensureAppEnvValidated = () => {
	if (hasValidated || !isServerRuntime()) return;
	const env = serverEnv();
	assertRequiredEnvVars(env);
	hasValidated = true;
};

export const registerAppEnvRequirements = (value: AppEnvRequirements) => {
	requirements = value;
	hasValidated = false;
	ensureAppEnvValidated();
};

export const getAppEnvVars = (appSlug: string) => {
	ensureRequirementsRegistered();
	ensureAppEnvValidated();

	const env = serverEnv();
	const keys = requirements![appSlug];

	if (!keys) {
		throw new Error(
			`Unknown app slug '${appSlug}' while resolving environment variables.`,
		);
	}

	const collected: Record<string, string> = {};

	for (const key of keys) {
		const value = env[key as keyof typeof env];
		if (typeof value !== "string") {
			throw new Error(
				`Missing environment variable '${key}' for app '${appSlug}'.`,
			);
		}

		const trimmed = value.trim();

		if (trimmed.length === 0) {
			throw new Error(
				`Environment variable '${key}' for app '${appSlug}' is empty.`,
			);
		}

		collected[key] = trimmed;
	}

	return Object.freeze(collected);
};

export const getServerEnv = () => serverEnv();

const normalizeDirectory = (directoryPath: string) =>
	resolvePath(directoryPath);

export const registerAppDirectory = (
	directoryPath: string,
	appSlug: string,
) => {
	const normalized = normalizeDirectory(directoryPath);
	appDirectoryToSlug.set(normalized, appSlug);
};

const findAppSlugForDirectory = (directoryPath: string) => {
	let current = normalizeDirectory(directoryPath);

	while (true) {
		const found = appDirectoryToSlug.get(current);
		if (found) return found;

		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return undefined;
};

const resolveDirectoryFromImportMeta = (importMetaUrl: string) => {
	if (
		typeof importMetaUrl === "string" &&
		importMetaUrl.startsWith("file://")
	) {
		return dirname(fileURLToPath(importMetaUrl));
	}

	if (typeof importMetaUrl === "string") {
		return dirname(normalizeDirectory(importMetaUrl));
	}

	throw new Error("Unable to resolve module directory from import.meta.url");
};

export const getAppSlugForModule = (importMetaUrl: string) => {
	const directory = resolveDirectoryFromImportMeta(importMetaUrl);
	const slug = findAppSlugForDirectory(directory);

	if (!slug) {
		throw new Error(
			`Unable to determine app slug for module at '${directory}'. ` +
				"Ensure the app manifest was registered before importing this module.",
		);
	}

	return slug;
};

export const getAppEnvVarsForModule = (importMetaUrl: string) =>
	getAppEnvVars(getAppSlugForModule(importMetaUrl));
