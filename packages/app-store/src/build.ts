import { createHash } from "node:crypto";
import {
	type BlockedApp,
	type Catalog,
	type CatalogApp,
	type CatalogAsset,
	type CatalogBackground,
	platformsFor,
} from "./catalog";
import { hashBytes, type LoadedApp } from "./validate";

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
