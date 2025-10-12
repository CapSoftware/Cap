import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";

export const AppManifestSchema = Schema.Struct({
	slug: Schema.String,
	displayName: Schema.String,
	description: Schema.String,
	icon: Schema.String,
	category: Schema.String,
	requiredEnvVars: Schema.Array(Schema.String),
	installModule: Schema.optional(Schema.String),
	image: Schema.String,
	documentation: Schema.String,
	contentPath: Schema.optional(Schema.String),
	publisher: Schema.Struct({
		name: Schema.String,
		email: Schema.String,
	}),
});

export type AppManifest = typeof AppManifestSchema.Type;

export const DEFAULT_INSTALL_MODULE = "./install.ts" as const;

const normalizeManifest = (manifest: AppManifest): ResolvedAppManifest =>
	Object.freeze({
		...manifest,
		installModule: manifest.installModule ?? DEFAULT_INSTALL_MODULE,
		requiredEnvVars: Object.freeze(
			Array.from(new Set(manifest.requiredEnvVars)),
		),
	});

const resolveManifestPath = (importMetaUrl: string): string => {
	const candidates = new Set<string>();

	try {
		const manifestUrl = new URL(importMetaUrl);
		if (manifestUrl.protocol === "file:") {
			const modulePath = fileURLToPath(manifestUrl);
			candidates.add(join(dirname(modulePath), "config.json"));
		}
	} catch {
		// Ignore failures resolving file URLs; we'll fall back to workspace search below.
	}

	const normalizedImportUrl = importMetaUrl.replace(/\\/g, "/");
	const directoryMatch = normalizedImportUrl.match(
		/(?:^|\/)packages\/apps\/(?:src|dist)\/([^/]+)\/[^/]*$/,
	);

	if (directoryMatch) {
		const directory = directoryMatch[1];
		let currentRoot = process.cwd();

		for (let depth = 0; depth < 5; depth += 1) {
			// Walk up the filesystem to find the workspace root when bundlers emit virtual URLs.
			candidates.add(
				join(currentRoot, "packages", "apps", "src", directory, "config.json"),
			);
			currentRoot = resolve(currentRoot, "..");
		}
	}

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	throw new Error(
		`Unable to resolve app config for module '${importMetaUrl}'. ` +
			"Ensure config.json exists alongside the module.",
	);
};

const loadManifest = (manifestPath: string): ResolvedAppManifest => {
	const manifestRaw = JSON.parse(readFileSync(manifestPath, "utf8"));

	let manifest: AppManifest;

	try {
		manifest = Effect.runSync(
			Schema.decodeUnknown(AppManifestSchema)(manifestRaw),
		);
	} catch (cause) {
		throw new Error(
			`Invalid manifest at ${manifestPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}

	return normalizeManifest(manifest);
};

type ResolvedAppManifest = Readonly<
	AppManifest & {
		installModule: string;
		requiredEnvVars: ReadonlyArray<string>;
	}
>;

export type AppConfig = ResolvedAppManifest;

export const getAppConfig = (importMetaUrl: string): AppConfig => {
	const manifestPath = resolveManifestPath(importMetaUrl);
	const manifest = loadManifest(manifestPath);
	return manifest;
};
