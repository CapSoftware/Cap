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

	it("reports a slow API estimate without claiming the recording is capped", () => {
		expect(
			describeUploadHealth(status({ kind: "slow", uploadMbps: 3.8 })),
		).toEqual({
			label: "API upload slow",
			detail: "~3.8 Mbps",
			tone: "warning",
		});
	});

	it("keeps zero Mbps as a measured slow upload value", () => {
		expect(
			describeUploadHealth(status({ kind: "slow", uploadMbps: 0 })),
		).toEqual({
			label: "API upload slow",
			detail: "~0.0 Mbps",
			tone: "warning",
		});
	});

	it("describes a failed API check as a possible quality limit", () => {
		expect(describeUploadHealth(status({ kind: "unavailable" }))).toEqual({
			label: "API check failed",
			detail: "Quality may be limited",
			tone: "danger",
		});
	});

	it("describes successful checks as estimates rather than recording readiness", () => {
		expect(
			describeUploadHealth(status({ kind: "healthy", uploadMbps: 18.2 })),
		).toEqual({
			label: "API estimate",
			detail: "~18 Mbps",
			tone: "good",
		});
	});

	it("does not label unsupported servers as a failed upload or healthy connection", () => {
		expect(describeUploadHealth(status({ kind: "unsupported" }))).toEqual({
			label: "Upload check unavailable",
			detail: "Server unsupported",
			tone: "neutral",
		});
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
		"does not display invalid speed %s as a measurement",
		(uploadMbps) => {
			expect(
				describeUploadHealth(status({ kind: "healthy", uploadMbps })).detail,
			).toBe("Not measured");
		},
	);

	it.each(["slow", "unavailable"] as const)(
		"does not infer an active destination cap from a %s probe recommendation",
		(kind) => {
			const presentation = describeUploadHealth(
				status({ kind, uploadMbps: 2, maxInstantResolution: 1280 }),
			);
			expect(presentation.label).toContain("API");
			expect(`${presentation.label}. ${presentation.detail}`).not.toMatch(
				/capped|storage speed|storage throughput/i,
			);
		},
	);

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
		"does not turn an invalid slow estimate %s into a claimed quality cap",
		(uploadMbps) => {
			expect(
				describeUploadHealth(
					status({ kind: "slow", uploadMbps, maxInstantResolution: 1280 }),
				),
			).toEqual({
				label: "API upload slow",
				detail: "Not measured",
				tone: "warning",
			});
		},
	);
});
