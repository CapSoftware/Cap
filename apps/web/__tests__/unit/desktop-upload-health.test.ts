import { describe, expect, it } from "vitest";
import {
	MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES,
	readUploadHealthProbeBytes,
	UploadHealthProbeTooLargeError,
} from "@/app/api/desktop/[...route]/uploadHealth";

describe("desktop upload health probe", () => {
	it("counts a bounded probe body without storing it", async () => {
		const body = new Uint8Array(64 * 1024);
		const request = new Request("https://cap.test/api/desktop/upload-health", {
			method: "POST",
			body,
		});

		await expect(readUploadHealthProbeBytes(request)).resolves.toBe(
			body.byteLength,
		);
	});

	it("allows exactly the configured maximum", async () => {
		const request = new Request("https://cap.test/api/desktop/upload-health", {
			method: "POST",
			body: new Uint8Array(MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES),
		});

		await expect(readUploadHealthProbeBytes(request)).resolves.toBe(
			MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES,
		);
	});

	it("rejects probes larger than the configured maximum", async () => {
		const request = new Request("https://cap.test/api/desktop/upload-health", {
			method: "POST",
			body: new Uint8Array(MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES + 1),
		});

		await expect(readUploadHealthProbeBytes(request)).rejects.toBeInstanceOf(
			UploadHealthProbeTooLargeError,
		);
	});
});
