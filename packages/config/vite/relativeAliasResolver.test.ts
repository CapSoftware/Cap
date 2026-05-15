import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import resolver from "./relativeAliasResolver";

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cap-config-vite-"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

const resolveAlias = async (source: string, importer: string) => {
	const result = await resolver.customResolver?.(source, importer, {});
	if (typeof result !== "string") throw new Error("Expected string resolution");
	return result;
};

describe("relativeAliasResolver", () => {
	it("resolves ~/ imports from a package src directory", async () => {
		const srcDir = path.join(tempDir, "pkg", "src");
		await fs.mkdir(path.join(srcDir, "components"), { recursive: true });
		await fs.writeFile(path.join(srcDir, "components", "Button.tsx"), "");

		await expect(
			resolveAlias(
				"~/components/Button",
				path.join(srcDir, "pages", "index.tsx"),
			),
		).resolves.toBe(path.join(srcDir, "components", "Button.tsx"));
	});

	it("resolves ~/ imports from the nearest package root", async () => {
		const pkgDir = path.join(tempDir, "pkg");
		await fs.mkdir(path.join(pkgDir, "src", "utils"), { recursive: true });
		await fs.writeFile(path.join(pkgDir, "package.json"), "{}");
		await fs.writeFile(path.join(pkgDir, "src", "utils", "index.ts"), "");

		await expect(
			resolveAlias("~/src/utils", path.join(pkgDir, "tests", "unit.test.ts")),
		).resolves.toBe(path.join(pkgDir, "src", "utils", "index.ts"));
	});

	it("stops at the filesystem root when no package.json can be found", async () => {
		await expect(
			resolveAlias("~/missing/file", path.join(tempDir, "loose", "test.ts")),
		).rejects.toThrow("Failed to resolve import path ~/missing/file");
	});
});
