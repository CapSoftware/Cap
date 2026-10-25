import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

const scannedRoots = [
	"app/(site)",
	"components/pages",
	"content",
	"lib/seo-metadata.ts",
	"public/llms.txt",
	"public/llms-full.txt",
];

const scannedExtensions = [".ts", ".tsx", ".md", ".mdx", ".json", ".txt"];

const staleLicenseClaim = /MIT[- ]licen[sc]|"Yes(?:,| —) MIT"/i;

function collectFiles(path: string): string[] {
	const absolute = join(root, path);
	if (!existsSync(absolute)) return [];
	if (statSync(absolute).isFile()) return [absolute];
	return readdirSync(absolute, { recursive: true, encoding: "utf-8" })
		.map((entry) => join(absolute, entry))
		.filter(
			(file) =>
				scannedExtensions.some((extension) => file.endsWith(extension)) &&
				statSync(file).isFile(),
		);
}

describe("public license claims", () => {
	it("does not describe Cap as MIT-licensed", () => {
		const files = scannedRoots.flatMap(collectFiles);
		expect(files.length).toBeGreaterThan(0);

		const offenders = files.flatMap((file) =>
			readFileSync(file, "utf-8")
				.split("\n")
				.flatMap((line, index) =>
					staleLicenseClaim.test(line)
						? [`${relative(root, file)}:${index + 1}`]
						: [],
				),
		);

		expect(offenders).toEqual([]);
	});
});
