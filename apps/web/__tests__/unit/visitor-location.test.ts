import { describe, expect, it, vi } from "vitest";
import {
	type GeoIpReader,
	geoIpLocation,
	lookupLocation,
} from "@/lib/visitor-location";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		CAP_GEOIP_DATABASE_PATH: "/nonexistent/dbip-city-lite.mmdb",
	}),
}));

describe("geoIpLocation", () => {
	it("returns null and warns once when the database file is missing", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(geoIpLocation("8.8.8.8")).toBeNull();
		expect(geoIpLocation("1.1.1.1")).toBeNull();
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});
});

const readerWith = (records: Record<string, unknown>): GeoIpReader => ({
	get: (ip) => {
		if (ip === "not-an-ip") throw new Error("Invalid IP address");
		return (records[ip] ?? null) as ReturnType<GeoIpReader["get"]>;
	},
});

describe("lookupLocation", () => {
	it("reads country, region and city from a GeoIP2 City record", () => {
		const reader = readerWith({
			"81.2.69.142": {
				country: { iso_code: "GB" },
				subdivisions: [{ iso_code: "ENG", names: { en: "England" } }],
				city: { names: { en: "London" } },
			},
		});
		expect(lookupLocation(reader, "81.2.69.142")).toEqual({
			country: "GB",
			region: "ENG",
			city: "London",
		});
	});

	// DB-IP Lite has subdivision names but no subdivision codes.
	it("falls back to the subdivision name when it has no code", () => {
		const reader = readerWith({
			"190.202.0.1": {
				country: { iso_code: "VE" },
				subdivisions: [{ names: { en: "Zulia" } }],
				city: { names: { en: "San Carlos del Zulia" } },
			},
		});
		expect(lookupLocation(reader, "190.202.0.1")).toEqual({
			country: "VE",
			region: "Zulia",
			city: "San Carlos del Zulia",
		});
	});

	it("keeps the country when the record has no region or city", () => {
		const reader = readerWith({
			"2001:db8::1": { country: { iso_code: "us" } },
		});
		expect(lookupLocation(reader, "2001:db8::1")).toEqual({
			country: "US",
			region: "",
			city: "",
		});
	});

	it("returns null for missing, unknown, private and invalid addresses", () => {
		const reader = readerWith({
			"10.0.0.1": { country: {} },
			"203.0.113.9": { country: { iso_code: "EU1" } },
		});
		for (const ip of [
			null,
			undefined,
			"",
			"127.0.0.1",
			"10.0.0.1",
			"203.0.113.9",
			"not-an-ip",
		]) {
			expect(lookupLocation(reader, ip)).toBeNull();
		}
	});
});
