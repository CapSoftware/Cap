import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const postPath = join(
	process.cwd(),
	"content/blog/how-to-record-screen-on-windows.mdx",
);
const postSource = readFileSync(postPath, "utf-8");

describe("how-to-record-screen-on-windows blog post frontmatter", () => {
	it("has a title field", () => {
		expect(postSource).toContain("title:");
	});

	it("title targets the windows screen recording keyword", () => {
		expect(postSource.toLowerCase()).toContain("record");
		expect(postSource.toLowerCase()).toContain("windows");
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

describe("how-to-record-screen-on-windows blog post content", () => {
	it("mentions Cap as the recommended tool", () => {
		expect(postSource).toContain("Cap");
	});

	it("covers Xbox Game Bar", () => {
		expect(postSource).toContain("Xbox Game Bar");
	});

	it("covers Snipping Tool", () => {
		expect(postSource).toContain("Snipping Tool");
	});

	it("covers OBS Studio", () => {
		expect(postSource).toContain("OBS");
	});

	it("mentions Windows 10 and Windows 11", () => {
		expect(postSource).toContain("Windows 10");
		expect(postSource).toContain("Windows 11");
	});

	it("includes a comparison section", () => {
		expect(postSource.toLowerCase()).toContain("comparison");
	});

	it("includes troubleshooting guidance", () => {
		expect(postSource.toLowerCase()).toContain("troubleshoot");
	});

	it("links to the download page", () => {
		expect(postSource).toContain("cap.so/download");
	});

	it("mentions system audio", () => {
		expect(postSource.toLowerCase()).toContain("system audio");
	});

	it("mentions microphone recording", () => {
		expect(postSource.toLowerCase()).toContain("microphone");
	});

	it("has a tips section", () => {
		expect(postSource.toLowerCase()).toContain("tips");
	});

	it("covers full desktop recording", () => {
		expect(postSource.toLowerCase()).toContain("full desktop");
	});
});
