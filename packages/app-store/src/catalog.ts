import { createHash } from "node:crypto";
import { Schema } from "effect";
import { BUILTIN_APPS, type BuiltinApp } from "./constants";
import {
	Author,
	CapEvent,
	CaptionStyle,
	ColorLook,
	ConnectionAction,
	ConnectionPermission,
	HexColor,
	ItemId,
	type Manifest,
	SettingField,
} from "./manifest";
import { hashBytes, type LoadedApp } from "./validate";

export const Platform = Schema.Literal("web", "desktop");
export type Platform = typeof Platform.Type;

export const CatalogAsset = Schema.Struct({
	url: Schema.String,
	sha256: Schema.String,
	bytes: Schema.Number,
	width: Schema.Number,
	height: Schema.Number,
});
export type CatalogAsset = typeof CatalogAsset.Type;

export const CatalogBackground = Schema.Union(
	Schema.Struct({
		kind: Schema.Literal("image"),
		id: ItemId,
		name: Schema.String,
		image: CatalogAsset,
	}),
	Schema.Struct({
		kind: Schema.Literal("gradient"),
		id: ItemId,
		name: Schema.String,
		from: HexColor,
		to: HexColor,
		angle: Schema.Number,
	}),
	Schema.Struct({
		kind: Schema.Literal("color"),
		id: ItemId,
		name: Schema.String,
		color: HexColor,
	}),
);
export type CatalogBackground = typeof CatalogBackground.Type;

export const CatalogConnection = Schema.Struct({
	url: Schema.String,
	permissions: Schema.Array(ConnectionPermission),
	events: Schema.Array(CapEvent),
	settings: Schema.Array(SettingField),
	actions: Schema.Array(ConnectionAction),
});
export type CatalogConnection = typeof CatalogConnection.Type;

export const CatalogApp = Schema.Struct({
	apiVersion: Schema.Number,
	id: Schema.String,
	name: Schema.String,
	version: Schema.String,
	description: Schema.String,
	author: Author,
	firstParty: Schema.Boolean,
	license: Schema.String,
	categories: Schema.Array(Schema.String),
	keywords: Schema.Array(Schema.String),
	homepage: Schema.optional(Schema.String),
	support: Schema.optional(Schema.String),
	privacyPolicy: Schema.optional(Schema.String),
	icon: CatalogAsset,
	screenshots: Schema.Array(CatalogAsset),
	readme: Schema.String,
	platforms: Schema.Array(Platform),
	builtin: Schema.optional(Schema.Literal(...BUILTIN_APPS)),
	backgrounds: Schema.Array(CatalogBackground),
	captionStyles: Schema.Array(CaptionStyle),
	colorLooks: Schema.Array(ColorLook),
	connection: Schema.optional(CatalogConnection),
	contentHash: Schema.String,
});
export type CatalogApp = typeof CatalogApp.Type;

export const BlockedApp = Schema.Struct({
	id: Schema.String,
	reason: Schema.String,
});
export type BlockedApp = typeof BlockedApp.Type;

export const Catalog = Schema.Struct({
	catalogVersion: Schema.Literal(1),
	revision: Schema.String,
	apps: Schema.Array(CatalogApp),
	blocked: Schema.Array(BlockedApp),
});
export type Catalog = typeof Catalog.Type;

export const BUILTIN_PLATFORMS: Record<BuiltinApp, Platform[]> = {
	slack: ["web"],
	"amazon-s3": ["web", "desktop"],
	"google-drive": ["web", "desktop"],
};

export function platformsFor(manifest: Manifest): Platform[] {
	const platforms = new Set<Platform>();
	if (manifest.builtin) {
		for (const platform of BUILTIN_PLATFORMS[manifest.builtin]) {
			platforms.add(platform);
		}
	}
	if (manifest.backgrounds || manifest.captionStyles || manifest.colorLooks) {
		platforms.add("desktop");
	}
	if (manifest.connection) {
		platforms.add("web");
		if ((manifest.connection.actions ?? []).length > 0) {
			platforms.add("desktop");
		}
	}
	return (["web", "desktop"] as const).filter((platform) =>
		platforms.has(platform),
	);
}

const EXTENSIONS: Record<string, string> = {
	png: "png",
	jpeg: "jpg",
	webp: "webp",
};

export type CatalogFile = { path: string; bytes: Uint8Array };

export type BuildCatalogOptions = {
	assetBaseUrl: string;
	blocked?: readonly BlockedApp[];
};

export function buildCatalog(
	apps: LoadedApp[],
	options: BuildCatalogOptions,
): { catalog: Catalog; files: CatalogFile[] } {
	const files = new Map<string, Uint8Array>();
	const base = options.assetBaseUrl.replace(/\/$/, "");

	const assetFor = (app: LoadedApp, path: string): CatalogAsset => {
		const bytes = app.files.get(path);
		const info = app.images.get(path);
		if (!bytes || !info) {
			throw new Error(`${app.id}: ${path} was not validated`);
		}
		const sha256 = hashBytes(bytes);
		const name = `${app.id}/${sha256.slice(0, 32)}.${EXTENSIONS[info.format]}`;
		files.set(name, bytes);
		return {
			url: `${base}/${name}`,
			sha256,
			bytes: bytes.byteLength,
			width: info.width,
			height: info.height,
		};
	};

	const blocked = [...(options.blocked ?? [])].sort((a, b) =>
		a.id.localeCompare(b.id),
	);
	const blockedIds = new Set(blocked.map((entry) => entry.id));

	const catalogApps = apps
		.filter((app) => !blockedIds.has(app.id))
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((app): CatalogApp => {
			const manifest = app.manifest;
			return {
				apiVersion: manifest.apiVersion,
				id: manifest.id,
				name: manifest.name,
				version: manifest.version,
				description: manifest.description,
				author: manifest.author,
				firstParty: manifest.author.github === "CapSoftware",
				license: manifest.license,
				categories: [...manifest.categories],
				keywords: [...(manifest.keywords ?? [])],
				homepage: manifest.homepage,
				support: manifest.support,
				privacyPolicy: manifest.privacyPolicy,
				icon: assetFor(app, "icon.png"),
				screenshots: (manifest.screenshots ?? []).map((path) =>
					assetFor(app, path),
				),
				readme: app.readme,
				platforms: platformsFor(manifest),
				builtin: manifest.builtin,
				backgrounds: (manifest.backgrounds ?? []).map(
					(background): CatalogBackground => {
						if ("image" in background) {
							return {
								kind: "image",
								id: background.id,
								name: background.name,
								image: assetFor(app, background.image),
							};
						}
						if ("gradient" in background) {
							return {
								kind: "gradient",
								id: background.id,
								name: background.name,
								...background.gradient,
							};
						}
						return {
							kind: "color",
							id: background.id,
							name: background.name,
							color: background.color,
						};
					},
				),
				captionStyles: [...(manifest.captionStyles ?? [])],
				colorLooks: [...(manifest.colorLooks ?? [])],
				connection: manifest.connection
					? {
							url: manifest.connection.url,
							permissions: [...(manifest.connection.permissions ?? [])],
							events: [...(manifest.connection.events ?? [])],
							settings: [...(manifest.connection.settings ?? [])],
							actions: [...(manifest.connection.actions ?? [])],
						}
					: undefined,
				contentHash: app.contentHash,
			};
		});

	const revision = createHash("sha256")
		.update(
			JSON.stringify({
				apps: catalogApps.map((app) => [app.id, app.contentHash]),
				blocked,
				base,
			}),
		)
		.digest("hex")
		.slice(0, 32);

	return {
		catalog: { catalogVersion: 1, revision, apps: catalogApps, blocked },
		files: [...files.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([path, bytes]) => ({ path, bytes })),
	};
}
