import {
	getNearestRegionalBucket,
	parseRegionalBuckets,
} from "@cap/web-backend/src/S3Buckets/RegionalBuckets";
import { S3Bucket } from "@cap/web-domain";
import { Option } from "effect";
import { describe, expect, it } from "vitest";

const regions = S3Bucket.RegionalBuckets;

describe("upload region selection", () => {
	it.each([
		["New York", "40.71", "-74.01", null],
		["San Francisco", "37.77", "-122.42", "cap-oregon"],
		["London", "51.51", "-0.13", "cap-ireland"],
		["Berlin", "52.52", "13.41", "cap-frankfurt"],
		["Buenos Aires", "-34.60", "-58.38", "cap-sao-paulo"],
		["Johannesburg", "-26.20", "28.04", "cap-cape-town"],
		["Delhi", "28.61", "77.21", "cap-mumbai"],
		["Bangkok", "13.76", "100.50", "cap-singapore"],
		["Tokyo", "35.68", "139.69", "cap-tokyo"],
		["Melbourne", "-37.81", "144.96", "cap-sydney"],
		["Fiji", "-18.14", "178.44", "cap-sydney"],
		["Samoa", "-13.85", "-171.75", "cap-sydney"],
	])(
		"selects the nearest configured region for %s",
		(_, latitude, longitude, expected) => {
			expect(
				Option.getOrNull(
					getNearestRegionalBucket(latitude, longitude, regions),
				),
			).toBe(expected);
		},
	);

	it.each([
		[undefined, undefined],
		["35.68", undefined],
		[undefined, "139.69"],
		["", ""],
		[" ", "139.69"],
		["35.68", " "],
		["NaN", "139.69"],
		["Infinity", "139.69"],
		["91", "0"],
		["-91", "0"],
		["0", "181"],
		["0", "-181"],
		["35.68,1", "139.69"],
	])(
		"defaults to Virginia for missing or invalid coordinates (%#)",
		(latitude, longitude) => {
			expect(
				Option.isNone(getNearestRegionalBucket(latitude, longitude, regions)),
			).toBe(true);
		},
	);

	it("uses only configured destinations and always considers Virginia", () => {
		const tokyo = regions.filter(
			(region) => region.region === "ap-northeast-1",
		);
		expect(Option.isNone(getNearestRegionalBucket("35.68", "139.69", []))).toBe(
			true,
		);
		expect(
			Option.isNone(getNearestRegionalBucket("51.51", "-0.13", tokyo)),
		).toBe(true);
		expect(
			Option.getOrNull(getNearestRegionalBucket("35.68", "139.69", tokyo)),
		).toBe("cap-tokyo");
	});

	it("keeps managed IDs distinct from customer IDs and within the database limit", () => {
		for (const region of regions) {
			expect(region.id).toContain("-");
			expect(region.id.length).toBeLessThanOrEqual(15);
			expect(S3Bucket.isCapManagedBucket(region.id)).toBe(true);
		}
		expect(new Set(regions.map((region) => region.id)).size).toBe(
			regions.length,
		);
		expect(S3Bucket.isCapManagedBucket(null)).toBe(true);
		expect(S3Bucket.isCapManagedBucket("customer1234567")).toBe(false);
	});

	it("ignores unsupported regions and rejects malformed configuration", () => {
		const bucket = {
			bucket: "cap-test-tokyo",
			bucketUrl: "https://tokyo.cap.test",
			distributionId: "ETOKYO",
		};
		expect(
			parseRegionalBuckets(JSON.stringify({ "not-a-region": bucket })),
		).toEqual([]);
		expect(
			parseRegionalBuckets(JSON.stringify({ "ap-northeast-1": bucket })),
		).toMatchObject([{ id: "cap-tokyo", ...bucket }]);
		expect(
			parseRegionalBuckets(
				JSON.stringify({
					"ap-northeast-1": { ...bucket, distributionId: " " },
				}),
			),
		).toEqual([]);
	});
	it("preserves valid regions when another region is misconfigured", () => {
		const config = parseRegionalBuckets(
			JSON.stringify({
				"ap-northeast-1": {
					bucket: "cap-test-tokyo",
					bucketUrl: "https://tokyo.cap.test",
					distributionId: "ETOKYO",
				},
				"eu-central-1": { bucket: "cap-test-frankfurt" },
			}),
		);
		expect(config.map((bucket) => bucket.id)).toEqual(["cap-tokyo"]);
	});
});
