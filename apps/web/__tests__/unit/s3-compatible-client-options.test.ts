import {
	isNeonObjectStorageEndpoint,
	s3CompatibleClientOptions,
} from "@cap/utils/s3";
import { describe, expect, it } from "vitest";

const neonEndpoint =
	"https://br-cool-darkness-a1b2c3d4.storage.c-2.us-east-2.aws.neon.tech";

describe("isNeonObjectStorageEndpoint", () => {
	it.each([
		neonEndpoint,
		"https://br-x.storage.c-1.eu-central-1.aws.neon.tech/",
		"HTTPS://BR-X.STORAGE.C-1.US-EAST-1.AWS.NEON.TECH",
	])("detects %s", (endpoint) => {
		expect(isNeonObjectStorageEndpoint(endpoint)).toBe(true);
	});

	it.each([
		undefined,
		null,
		"",
		"not a url",
		"https://s3.amazonaws.com",
		"https://account.r2.cloudflarestorage.com",
		"https://project.supabase.co/storage/v1/s3",
		"http://localhost:9000",
		"https://ep-cool-darkness.us-east-2.aws.neon.tech",
		"https://storage.neon.tech.example.com",
	])("ignores %s", (endpoint) => {
		expect(isNeonObjectStorageEndpoint(endpoint)).toBe(false);
	});
});

describe("s3CompatibleClientOptions", () => {
	it("forces path-style requests for Neon endpoints", () => {
		expect(s3CompatibleClientOptions(neonEndpoint)).toEqual({
			forcePathStyle: true,
		});
	});

	it("leaves other providers on SDK defaults", () => {
		expect(s3CompatibleClientOptions("https://s3.amazonaws.com")).toEqual({});
		expect(s3CompatibleClientOptions(undefined)).toEqual({});
	});
});
