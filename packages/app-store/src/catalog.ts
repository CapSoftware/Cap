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
