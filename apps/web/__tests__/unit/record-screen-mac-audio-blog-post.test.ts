import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const postPath = join(
	process.cwd(),
	"content/blog/how-to-record-screen-on-mac-with-audio.mdx",
);
const postSource = readFileSync(postPath, "utf-8");

describe("how-to-record-screen-on-mac-with-audio blog post frontmatter", () => {
	it("has a title field", () => {
		expect(postSource).toContain("title:");
	});

	it("title targets the mac screen recording with audio keyword", () => {
		expect(postSource.toLowerCase()).toContain("record");
		expect(postSource.toLowerCase()).toContain("mac");
		expect(postSource.toLowerCase()).toContain("audio");
	});

	it("has a description field", () => {
		expect(postSource).toContain("description:");
	});

	it("has a publishedAt date", () => {
		expect(postSource).toMatch(/publishedAt:\s*["']\d{4}-\d{2}-\d{2}["']/);
	});

	it("has a category field", () => {
		expect(postSource).toContain("category:");
	});

	it("has an image field", () => {
		expect(postSource).toContain("image:");
	});

	it("has an author field", () => {
		expect(postSource).toContain("author:");
	});

	it("has a tags field", () => {
		expect(postSource).toContain("tags:");
	});
});

describe("how-to-record-screen-on-mac-with-audio blog post content", () => {
	it("mentions Cap as the recommended tool", () => {
		expect(postSource).toContain("Cap");
	});

	it("explains system audio limitation on macOS", () => {
		expect(postSource.toLowerCase()).toContain("system audio");
	});

	it("covers the Cap method", () => {
		expect(postSource).toContain("cap.so");
	});

	it("covers the QuickTime + BlackHole method", () => {
		expect(postSource).toContain("BlackHole");
		expect(postSource).toContain("QuickTime");
	});

	it("mentions microphone recording", () => {
		expect(postSource.toLowerCase()).toContain("microphone");
	});

	it("includes a comparison section", () => {
		expect(postSource.toLowerCase()).toContain("comparison");
	});

	it("includes troubleshooting guidance", () => {
		expect(postSource.toLowerCase()).toContain("fix");
	});

	it("links to the download page", () => {
		expect(postSource).toContain("cap.so/download");
	});

	it("mentions macOS versions and Apple Silicon", () => {
		expect(postSource.toLowerCase()).toContain("m-series");
	});

	it("mentions OBS as an alternative", () => {
		expect(postSource).toContain("OBS");
	});

	it("has a tips section", () => {
		expect(postSource.toLowerCase()).toContain("tips");
	});
});
