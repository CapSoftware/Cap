import {
	APP_STORE_API_VERSIONS,
	Catalog,
	type CatalogApp,
} from "@cap/app-store";
import { Schema } from "effect";
import generated from "./generated/catalog.json";

let cached: Catalog | null = null;

export function getAppStoreCatalog(): Catalog {
	if (!cached) cached = Schema.decodeUnknownSync(Catalog)(generated);
	return cached;
}

export function getCatalogApp(appId: string): CatalogApp | null {
	return getAppStoreCatalog().apps.find((app) => app.id === appId) ?? null;
}

export function isSupportedApiVersion(apiVersion: number) {
	return APP_STORE_API_VERSIONS.some((version) => version === apiVersion);
}

export function catalogForClient(maxApiVersion: number | null): Catalog {
	const catalog = getAppStoreCatalog();
	if (maxApiVersion === null) return catalog;
	return {
		...catalog,
		apps: catalog.apps.filter((app) => app.apiVersion <= maxApiVersion),
	};
}
