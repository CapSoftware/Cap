import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { compareImages, generateDiffImage, saveGolden } from "./compare-images";
import { goldenConfigs } from "./golden-configs";
import { getGoldenPath, renderGolden } from "./render-harness";

const UPDATE_GOLDENS = process.env.UPDATE_GOLDENS === "true";
const PARITY_THRESHOLD = 0.001;

describe("renderer parity tests", () => {
	describe("golden image comparison", () => {
		for (const goldenConfig of goldenConfigs) {
			it(`renders ${goldenConfig.name} matching golden baseline`, async () => {
				const result = renderGolden(goldenConfig);
				const goldenPath = getGoldenPath(goldenConfig.name);

				if (UPDATE_GOLDENS || !existsSync(goldenPath)) {
					const dir = dirname(goldenPath);
					if (!existsSync(dir)) {
						mkdirSync(dir, { recursive: true });
					}
					saveGolden(goldenPath, result.png);
					console.log(`Updated golden: ${goldenConfig.name}`);
					return;
				}

				const comparison = await compareImages(
					result.png,
					goldenPath,
					PARITY_THRESHOLD,
				);

				if (!comparison.match) {
					const diffPath = goldenPath.replace(".png", "-diff.png");
					const diffImage = await generateDiffImage(result.png, goldenPath);
					if (diffImage) {
						writeFileSync(diffPath, diffImage);
					}

					const actualPath = goldenPath.replace(".png", "-actual.png");
					writeFileSync(actualPath, result.png);
				}

				expect(comparison.match).toBe(true);
				expect(comparison.diffPercent).toBeLessThanOrEqual(
					PARITY_THRESHOLD * 100,
				);
			});
		}
	});

	describe("spec computation consistency", () => {
		it("produces deterministic specs across runs", () => {
			for (const goldenConfig of goldenConfigs) {
				const result1 = renderGolden(goldenConfig);
				const result2 = renderGolden(goldenConfig);

				expect(result1.spec).toEqual(result2.spec);
				expect(result1.width).toBe(result2.width);
				expect(result1.height).toBe(result2.height);
			}
		});

		it("all golden configs have unique names", () => {
			const names = goldenConfigs.map((c) => c.name);
			const uniqueNames = new Set(names);
			expect(uniqueNames.size).toBe(names.length);
		});

		it("all golden specs have valid dimensions", () => {
			for (const goldenConfig of goldenConfigs) {
				const result = renderGolden(goldenConfig);
				expect(result.width).toBeGreaterThan(0);
				expect(result.height).toBeGreaterThan(0);
				expect(result.width % 2).toBe(0);
				expect(result.height % 2).toBe(0);
			}
		});
	});
});
