import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(process.cwd(), "../..");
const minimumSharpVersion = "0.35.5";

function parseVersion(version: string): number[] {
	const [release = ""] = version.split("-");
	return release.split(".").map((part) => Number.parseInt(part, 10));
}

function isAtLeast(version: string, minimum: string): boolean {
	const actual = parseVersion(version);
	const required = parseVersion(minimum);
	for (let index = 0; index < required.length; index++) {
		const difference = (actual[index] ?? 0) - (required[index] ?? 0);
		if (difference !== 0) return difference > 0;
	}
	return true;
}

function lockedVersions(packageName: string): string[] {
	const lockfile = readFileSync(join(repoRoot, "bun.lock"), "utf-8");
	const escaped = packageName.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	const entry = new RegExp(`\\["${escaped}@(\\d[^"]*)"`, "g");
	return [...lockfile.matchAll(entry)].flatMap((match) =>
		match[1] ? [match[1]] : [],
	);
}

function installedVersion(fromFile: string, packageName: string): string {
	let directory = dirname(createRequire(fromFile).resolve(packageName));
	while (!existsSync(join(directory, "package.json"))) {
		directory = dirname(directory);
	}
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf-8"))
		.version as string;
}

describe("sharp dependency version", () => {
	it("locks every sharp resolution at or above the minimum", () => {
		const versions = lockedVersions("sharp");
		expect(versions.length).toBeGreaterThan(0);
		expect(
			versions.filter((version) => !isAtLeast(version, minimumSharpVersion)),
		).toEqual([]);
	});

	it("locks the native sharp builds to the same minimum", () => {
		const versions = lockedVersions("@img/sharp-linux-x64");
		expect(versions.length).toBeGreaterThan(0);
		expect(
			versions.filter((version) => !isAtLeast(version, minimumSharpVersion)),
		).toEqual([]);
	});

	it("installs sharp at or above the minimum for the app and for next", () => {
		const webManifest = join(process.cwd(), "package.json");
		const nextManifest =
			createRequire(webManifest).resolve("next/package.json");
		expect(
			isAtLeast(installedVersion(webManifest, "sharp"), minimumSharpVersion),
		).toBe(true);
		expect(
			isAtLeast(installedVersion(nextManifest, "sharp"), minimumSharpVersion),
		).toBe(true);
	});
});
