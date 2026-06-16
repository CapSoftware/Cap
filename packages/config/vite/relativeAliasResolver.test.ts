import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import resolver from "./relativeAliasResolver";

let testRoot: string | undefined;

afterEach(async () => {
	if (testRoot) await rm(testRoot, { recursive: true, force: true });
	testRoot = undefined;
});

describe("relativeAliasResolver", () => {
	it("resolves ~/ imports relative to a package src directory", async () => {
		testRoot = await mkdtemp(join(tmpdir(), "cap-alias-"));
		await mkdir(join(testRoot, "src", "nested"), { recursive: true });
		await writeFile(join(testRoot, "package.json"), "{}");
		await writeFile(join(testRoot, "src", "nested", "target.ts"), "");

		const customResolver = resolver.customResolver;
		if (!customResolver) throw new Error("customResolver is not configured");

		const resolved = await customResolver(
			"~/nested/target",
			join(testRoot, "src", "importer.ts"),
			{},
		);

		expect(resolved).toBe(join(testRoot, "src", "nested", "target.ts"));
	});
});
