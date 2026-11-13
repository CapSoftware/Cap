import { readFileSync } from "node:fs";
import { serverEnv } from "@cap/env";
import { type CityResponse, Reader } from "mmdb-lib";

export type VisitorLocation = {
	country: string;
	region: string;
	city: string;
};

type GeoIpRecord = {
	country?: { iso_code?: string };
	subdivisions?: Array<{ iso_code?: string; names?: { en?: string } }>;
	city?: { names?: { en?: string } };
};

export type GeoIpReader = { get(ip: string): GeoIpRecord | null };

const MAX_LENGTH = 256;

const clean = (value: string | undefined) =>
	value?.trim().slice(0, MAX_LENGTH) ?? "";

export function lookupLocation(
	reader: GeoIpReader,
	ip: string | null | undefined,
): VisitorLocation | null {
	if (!ip) return null;
	let record: GeoIpRecord | null;
	try {
		record = reader.get(ip);
	} catch {
		return null;
	}
	const country = clean(record?.country?.iso_code).toUpperCase();
	if (!/^[A-Z]{2}$/.test(country)) return null;
	const subdivision = record?.subdivisions?.[0];
	return {
		country,
		region: clean(subdivision?.iso_code || subdivision?.names?.en),
		city: clean(record?.city?.names?.en),
	};
}

let reader: GeoIpReader | null | undefined;

function geoIpReader(): GeoIpReader | null {
	if (reader !== undefined) return reader;
	reader = null;
	const path = serverEnv().CAP_GEOIP_DATABASE_PATH?.trim();
	if (!path) return reader;
	try {
		reader = new Reader<CityResponse>(readFileSync(path));
	} catch (error) {
		console.warn(
			`[geoip] Could not open ${path}; views keep no location`,
			error,
		);
	}
	return reader;
}

/**
 * Location of an IP from the GeoIP database in CAP_GEOIP_DATABASE_PATH, for
 * hosts other than Vercel, which sends no x-vercel-ip-* headers.
 */
export function geoIpLocation(
	ip: string | null | undefined,
): VisitorLocation | null {
	const current = geoIpReader();
	return current ? lookupLocation(current, ip) : null;
}
