import { compileMDX } from "next-mdx-remote/rsc";
import { describe, expect, it } from "vitest";
import { developerOpenApiSpec } from "@/lib/developer-openapi";
import { extractHeadings, getDocBySlug } from "@/utils/docs";
import { docsConfig } from "../../app/(docs)/docs/docs-config";

const guide = getDocBySlug("api/get-started");
const content = guide?.content ?? "";

const codeBlocks = (language: string) =>
	[...content.matchAll(/^```(\w+)\n([\s\S]*?)\n```$/gm)]
		.filter((match) => match[1] === language)
		.map((match) => match[2] ?? "");

describe("the Get Started guide", () => {
	it("opens the API section of the sidebar and is linked from the reference", () => {
		const group = docsConfig.sidebar.find(
			(section) => section.title === "API & Developers",
		);
		expect(group?.items[0]).toEqual({
			title: "Get Started",
			slug: "api/get-started",
		});
		expect(guide?.metadata.title).toBe("Get Started");
		expect(guide?.metadata.summary).toBeTruthy();
		expect(getDocBySlug("api/rest-api")?.content).toContain(
			"](/docs/api/get-started)",
		);
	});

	it("compiles as MDX and links only to pages and headings that exist", async () => {
		await expect(
			compileMDX({ source: content, components: {} }),
		).resolves.toBeDefined();

		const links = [
			...content.matchAll(/\]\(\/docs\/([^#)\s]+)(?:#([\w-]+))?\)/g),
		];
		expect(links.length).toBeGreaterThan(10);
		for (const [, slug, anchor] of links) {
			const target = getDocBySlug(slug ?? "");
			expect(target, `missing page ${slug}`).toBeDefined();
			if (!anchor) continue;
			expect(
				extractHeadings(target?.content ?? "").map((heading) => heading.slug),
				`${slug}#${anchor}`,
			).toContain(anchor);
		}
	});

	it("calls only paths the API serves", () => {
		const served = Object.keys(developerOpenApiSpec("https://cap.so").paths);
		const matches = (path: string) =>
			served.some((pattern) =>
				new RegExp(`^${pattern.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(path),
			);
		const called = [
			...content.matchAll(/(?:GET|POST|DELETE) (\/api\/developer\/[\w/:-]+)/g),
		].map((match) => (match[1] ?? "").replace(/:(\w+)/g, "x"));

		expect(called.length).toBeGreaterThan(3);
		for (const path of called) {
			expect(matches(path), path).toBe(true);
		}
		for (const step of ["initiate", "presign-part", "complete"]) {
			expect(matches(`/api/developer/sdk/v1/upload/multipart/${step}`)).toBe(
				true,
			);
			expect(content).toContain(`"${step}"`);
		}
	});

	it("keeps real credentials, the CLI and the em dash out", () => {
		expect(content).not.toContain("—");
		expect(content).not.toMatch(/\bcap (guide|record|upload|caps|mcp)\b/);
		expect(content).not.toMatch(/\bMCP\b/);
		const keys = content.match(/\bc(?:sk|pk|ut)_[A-Za-z0-9._-]+/g) ?? [];
		expect(keys.every((key) => key === "csk_your_secret_key")).toBe(true);
	});

	it("paces its status checks under the secret key's limit", () => {
		const browser = codeBlocks("html").find((block) =>
			block.includes("async function waitForVideo"),
		);
		expect(browser).toContain("let delay = 3000");
		expect(browser).toContain('response.headers.get("Retry-After")');
		expect(codeBlocks("js").join("\n")).toContain("await sleep(3000)");
		expect(codeBlocks("python").join("\n")).toContain("time.sleep(3)");
	});
});
