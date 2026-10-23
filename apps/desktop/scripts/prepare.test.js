import { describe, expect, it } from "vitest";
import { createLinuxBundleConfig } from "../../../scripts/linux-bundle-config.mjs";
import { deepMerge } from "./prepare.js";

describe("Tauri platform release configuration", () => {
	it("preserves generated Linux shared-library mappings when adding GPUI", () => {
		const existing = createLinuxBundleConfig(["libavcodec.so.61"]);

		const merged = deepMerge(existing, {
			bundle: { externalBin: ["binaries/cap-gpui"] },
		});

		expect(merged.bundle.externalBin).toEqual(["binaries/cap-gpui"]);
		for (const format of ["deb", "rpm", "appimage"]) {
			expect(merged.bundle.linux[format]).toEqual(
				existing.bundle.linux[format],
			);
		}
	});

	it("preserves Windows resource mappings when platform overrides are applied", () => {
		const merged = deepMerge(
			{
				bundle: {
					externalBin: ["binaries/cap-cli", "binaries/cap-gpui"],
					resources: { "ffmpeg/*.dll": "./" },
				},
			},
			{ bundle: { windows: { wix: { version: "0.6.0" } } } },
		);

		expect(merged.bundle.externalBin).toContain("binaries/cap-gpui");
		expect(merged.bundle.resources).toEqual({ "ffmpeg/*.dll": "./" });
		expect(merged.bundle.windows.wix.version).toBe("0.6.0");
	});
});
