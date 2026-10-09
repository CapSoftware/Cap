import { describe, expect, it } from "vitest";
import {
	describeUploadHealth,
	formatUploadMbps,
	type UploadHealthStatus,
} from "./upload-health";

const status = (
	overrides: Partial<UploadHealthStatus>,
): UploadHealthStatus => ({
	kind: "unknown",
	uploadMbps: null,
	maxInstantResolution: null,
	checkedAtUnixMs: null,
	stale: false,
	message: "",
	...overrides,
});

describe("upload health presentation", () => {
	it("formats low and high Mbps values", () => {
		expect(formatUploadMbps(4.25)).toBe("4.3 Mbps");
		expect(formatUploadMbps(18.2)).toBe("18 Mbps");
	});

	it("shows a neutral state before the first check", () => {
		expect(describeUploadHealth(null)).toEqual({
			label: "Upload health",
			detail: "Not checked",
			tone: "neutral",
		});
	});

	it("does not trust stale checks", () => {
		expect(
			describeUploadHealth(status({ kind: "healthy", stale: true })),
		).toEqual({
			label: "Upload health",
			detail: "Check is stale",
			tone: "neutral",
		});
	});

	it("warns when slow upload caps Instant quality", () => {
		expect(
			describeUploadHealth(status({ kind: "slow", uploadMbps: 3.8 })),
		).toEqual({
			label: "Upload slow",
			detail: "3.8 Mbps, capped",
			tone: "warning",
		});
	});

	it("keeps zero Mbps as a measured slow upload value", () => {
		expect(
			describeUploadHealth(status({ kind: "slow", uploadMbps: 0 })),
		).toEqual({
			label: "Upload slow",
			detail: "0.0 Mbps, capped",
			tone: "warning",
		});
	});

	it("reports unavailable upload checks as capped", () => {
		expect(describeUploadHealth(status({ kind: "unavailable" }))).toEqual({
			label: "Upload offline",
			detail: "Instant capped",
			tone: "danger",
		});
	});
});
