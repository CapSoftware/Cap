import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({ from: () => ({ where: async () => [] }) }),
	}),
}));
vi.mock("@cap/database/schema", () => ({ organizations: {} }));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
}));

import { GET } from "@/app/api/docs/markdown/[...slug]/route";
import { CAP_AGENT_PROMPT } from "@/data/agent-prompt";
import { DOCS_MARKDOWN_ROUTE, docsMarkdownSlug } from "@/lib/agent-markdown";
import { docToMarkdown } from "@/lib/docs-markdown";
import { proxy } from "../../proxy";
import { getAllDocs, getDocBySlug } from "@/utils/docs";

const getMarkdown = (slug: string, method = "GET") =>
	GET(new Request(`https://cap.so/docs/${slug}.md`, { method }), {
		params: Promise.resolve({ slug: slug.split("/") }),
	});

// Lines outside fenced code blocks, where MDX components would render.
const proseLines = (markdown: string) => {
	const lines: string[] = [];
	let fence: string | null = null;
	for (const line of markdown.split("\n")) {
		const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length)
				fence = null;
		} else if (marker) fence = marker;
		else lines.push(line);
	}
	return lines;
};

describe("docsMarkdownSlug", () => {
	it.each([
		["/docs/api/rest-api.md", "text/html", "api/rest-api"],
		["/docs/api/rest-api.mdx", null, "api/rest-api"],
		["/docs/api/rest-api", "text/markdown", "api/rest-api"],
		["/docs/api/rest-api/", "text/markdown", "api/rest-api"],
		["/docs", "text/markdown", "introduction"],
		["/docs.md", null, "introduction"],
		["/docs/api/rest-api", "text/html,*/*;q=0.8", null],
		["/docs/api/rest-api", null, null],
		["/pricing.md", null, null],
		["/docsearch", "text/markdown", null],
	])("%s with Accept %s gives %s", (path, accept, slug) => {
		expect(docsMarkdownSlug(path, accept)).toBe(slug);
	});
});

describe("docToMarkdown", () => {
	const docs = getAllDocs();

	it.each(docs.map((doc) => [doc.slug, doc] as const))(
		"turns %s into plain Markdown",
		(_slug, doc) => {
			const markdown = docToMarkdown(doc, "https://cap.so");
			expect(markdown.startsWith(`# ${doc.metadata.title}\n`)).toBe(true);
			expect(markdown).not.toMatch(/^---\n/);
			for (const line of proseLines(markdown)) {
				expect(line).not.toMatch(/^\s*<\/?[A-Z]/);
				expect(line).not.toMatch(/\]\(\/[^/]/);
			}
		},
	);

	it("keeps every code block exactly as written", () => {
		const doc = getDocBySlug("api/get-started");
		if (!doc) throw new Error("missing get-started doc");
		const markdown = docToMarkdown(doc, "https://cap.so");
		const blocks = doc.content.match(/```[\s\S]*?\n```/g) ?? [];
		expect(blocks.length).toBeGreaterThan(5);
		for (const block of blocks) expect(markdown).toContain(block);
	});

	it("shows the copyable prompt and warnings as text", () => {
		const agents = getDocBySlug("agents");
		const selfHosting = getDocBySlug("self-hosting");
		if (!agents || !selfHosting) throw new Error("missing docs");
		expect(docToMarkdown(agents, "https://cap.so")).toContain(CAP_AGENT_PROMPT);
		const hosting = docToMarkdown(selfHosting, "https://cap.so");
		expect(hosting).toContain(
			"> **Security Notice for Production Deployments**",
		);
		expect(hosting).toContain(
			"[Watch the video](https://cap.so/embed/k310v2vf41d6ffp)",
		);
	});
});

describe("docs Markdown route", () => {
	it("serves a docs page as Markdown", async () => {
		const response = await getMarkdown("api/rest-api");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"text/markdown; charset=utf-8",
		);
		expect(response.headers.get("vary")).toBe("Accept");
		const body = await response.text();
		expect(body.startsWith("# REST API\n")).toBe(true);
		expect(body).toContain("every 3 seconds");
		expect(body).not.toContain("<html");
	});

	it("answers a missing page with a Markdown 404", async () => {
		const response = await getMarkdown("api/nope");
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toBe(
			"text/markdown; charset=utf-8",
		);
		expect(await response.text()).toContain("/docs/api/nope");
	});

	it("refuses a path outside the docs folder", async () => {
		const response = await getMarkdown("../../package");
		expect(response.status).toBe(404);
	});
});

describe("proxy routes docs Markdown requests", () => {
	const send = (path: string, accept: string, method = "GET") =>
		proxy(
			new NextRequest(`https://cap.so${path}`, {
				method,
				headers: { accept },
			}),
		);
	const rewriteOf = (response: Response) =>
		response.headers.get("x-middleware-rewrite");

	it.each([
		["/docs/api/get-started", "text/markdown"],
		["/docs/api/get-started.md", "text/html,*/*;q=0.8"],
	])("rewrites %s (Accept %s)", async (path, accept) => {
		const response = await send(path, accept);
		expect(rewriteOf(response)).toBe(
			`https://cap.so${DOCS_MARKDOWN_ROUTE}/api/get-started`,
		);
	});

	it("leaves the HTML page alone for a browser", async () => {
		const response = await send(
			"/docs/api/get-started",
			"text/html,application/xhtml+xml,*/*;q=0.8",
		);
		expect(rewriteOf(response)).toBeNull();
		expect(response.headers.get("x-middleware-next")).toBe("1");
	});
});
