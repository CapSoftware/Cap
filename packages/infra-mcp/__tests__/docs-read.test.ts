import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	capMarkdown,
	DOC_PAGES,
	DOCS_MAX_BYTES,
	docAnchor,
	fetchDocs,
	readDoc,
} from "../src/docs";
import { INSTRUCTIONS } from "../src/server";
import { connect, expectNoSecrets, type Session } from "./harness";
import { type StubApi, startStubApi } from "./stub-api";

const source = (page: string) => {
	const file = readFileSync(
		new URL(`../../../apps/web/content/docs/api/${page}.mdx`, import.meta.url),
		"utf8",
	);
	const title = /title:\s*"([^"]+)"/.exec(file)?.[1] ?? page;
	return `# ${title}\n\n${file.replace(/^---[\s\S]*?---\s*/, "")}`;
};

const mainHeadings = (markdown: string) => {
	const headings: string[] = [];
	let fenced = false;
	for (const line of markdown.split("\n")) {
		if (/^\s*(`{3,}|~{3,})/.test(line)) fenced = !fenced;
		else if (!fenced && line.startsWith("## ")) headings.push(line.slice(3));
	}
	return headings;
};

const bytes = (text: string) => new TextEncoder().encode(text).length;

let stub: StubApi;
let session: Session;

beforeEach(async () => {
	stub = await startStubApi();
	for (const page of DOC_PAGES) stub.state.docs.set(page, source(page));
	session = await connect(stub);
});

afterEach(async () => {
	expectNoSecrets(stub, session.output);
	await session.close();
	await stub.close();
});

describe("docs_read", () => {
	it("is listed as a read-only tool and named in the instructions", async () => {
		const { tools } = await session.client.listTools();
		const docs = tools.find((entry) => entry.name === "docs_read");
		expect(docs?.annotations).toMatchObject({ readOnlyHint: true });
		expect(docs?.inputSchema.additionalProperties).toBe(false);
		expect(INSTRUCTIONS).toContain(
			"For embed options, webhooks, billing rules and anything else in the docs, use docs_read.",
		);
	});

	it.each(DOC_PAGES)(
		"returns the outline and first section of %s",
		async (page) => {
			const reply = await session.call("docs_read", { page });
			expect(reply.isError).toBe(false);
			expect(reply.body.pageUrl).toBe(`${stub.url}/docs/api/${page}`);
			expect(reply.body.outline).toEqual(
				expect.arrayContaining(
					mainHeadings(source(page)).map((heading) => `## ${heading}`),
				),
			);
			expect(String(reply.body.markdown)).toMatch(/^# /);
			expect(bytes(String(reply.body.markdown))).toBeLessThanOrEqual(
				DOCS_MAX_BYTES,
			);
		},
	);

	it.each(DOC_PAGES)(
		"resolves every main heading of %s as a section",
		async (page) => {
			const headings = mainHeadings(source(page));
			expect(headings.length).toBeGreaterThan(3);
			for (const heading of headings) {
				const reply = await session.call("docs_read", {
					page,
					section: heading.toUpperCase(),
				});
				expect(reply.isError, heading).toBe(false);
				expect(reply.body.section).toBe(heading);
				expect(reply.body.url).toBe(
					`${stub.url}/docs/api/${page}#${docAnchor(heading)}`,
				);
				expect(String(reply.body.markdown).startsWith(`## ${heading}\n`)).toBe(
					true,
				);
				expect(bytes(String(reply.body.markdown))).toBeLessThanOrEqual(
					DOCS_MAX_BYTES,
				);
			}
		},
	);

	it("finds the embed options and the signature check", async () => {
		const embed = await session.call("docs_read", {
			page: "rest-api",
			section: "embed options",
		});
		expect(embed.body.section).toBe("Embed Options");
		expect(embed.body.url).toBe(`${stub.url}/docs/api/rest-api#embed-options`);

		const numbered = await session.call("docs_read", {
			page: "get-started",
			section: "use with agents (mcp)",
		});
		expect(numbered.body.section).toBe("10. Use with agents (MCP)");
		expect(numbered.body.url).toBe(
			`${stub.url}/docs/api/get-started#10-use-with-agents-mcp`,
		);

		const signature = await session.call("docs_read", {
			page: "webhooks",
			query: "verify signature",
		});
		expect(signature.body.section).toBe("Verify the signature");
		expect(String(signature.body.markdown)).toMatch(/HMAC|hmac/);

		const autoTopUp = await session.call("docs_read", {
			page: "billing",
			query: "auto top-up",
		});
		expect(autoTopUp.body.section).toBe("Auto top-up");
	});

	it("returns the outline and says so when nothing matches", async () => {
		const missing = await session.call("docs_read", {
			page: "webhooks",
			section: "no such heading here",
		});
		expect(missing.isError).toBe(false);
		expect(missing.body).toMatchObject({ found: false });
		expect(String(missing.body.message)).toMatch(/no such heading here/);
		expect(missing.body.outline).toContain("## Verify the signature");

		const nothing = await session.call("docs_read", {
			page: "billing",
			query: "zzqqxx",
		});
		expect(nothing.body).toMatchObject({ found: false });
	});

	it("caps a long section and links the rest", async () => {
		const reply = await session.call("docs_read", {
			page: "rest-api",
			section: "REST API Endpoints",
		});
		const markdown = String(reply.body.markdown);
		expect(reply.body.truncated).toBe(true);
		expect(bytes(markdown)).toBeLessThanOrEqual(DOCS_MAX_BYTES);
		expect(
			markdown.endsWith(
				`\n\nMore at ${stub.url}/docs/api/rest-api#rest-api-endpoints`,
			),
		).toBe(true);
	});

	it("refuses unknown keys, unknown pages and both section and query", async () => {
		const refusal = async (args: Record<string, unknown>) => {
			const result = await session.client.callTool({
				name: "docs_read",
				arguments: args,
			});
			expect(result.isError).toBe(true);
			return (result.content as { text: string }[])[0]?.text ?? "";
		};
		const extra = await refusal({ page: "billing", heading: "Credits" });
		expect(extra).toContain('Unrecognized key: "heading"');
		expect(extra).toContain("This tool accepts page, section and query");
		expect(await refusal({ page: "pricing" })).toMatch(/page/);

		const both = await session.call("docs_read", {
			page: "billing",
			section: "Credits",
			query: "credits",
		});
		expect(both.isError).toBe(true);
		expect(both.body).toMatchObject({ error: { code: "invalid_arguments" } });
	});

	it("fetches each page once without the secret key, and reports a page it cannot read", async () => {
		await session.call("docs_read", { page: "billing" });
		await session.call("docs_read", { page: "billing", section: "Credits" });
		const fetched = stub.requests.filter(
			(request) => request.path === "/docs/api/billing.md",
		);
		expect(fetched).toHaveLength(1);
		expect(fetched[0]?.headers.authorization).toBeUndefined();

		stub.state.docs.delete("webhooks");
		const failed = await session.call("docs_read", { page: "webhooks" });
		expect(failed.isError).toBe(true);
		expect(failed.body).toMatchObject({
			error: { code: "docs_unavailable" },
		});
		expect(
			String(failed.body.error && JSON.stringify(failed.body.error)),
		).toContain(`${stub.url}/docs/api/webhooks`);
	});
});

describe("fetchDocs", () => {
	it("reports a body that fails mid-read as docs_unavailable with the page link", async () => {
		const broken = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("# Billing\n"));
				controller.error(new Error("connection reset"));
			},
		});
		const source = fetchDocs(
			"https://docs.test",
			async () => new Response(broken),
		);
		await expect(
			source("billing", new AbortController().signal),
		).rejects.toMatchObject({
			code: "docs_unavailable",
			hint: "Try again, or read https://docs.test/docs/api/billing directly.",
		});
	});

	it("reports a cancellation as cancelled, not as unavailable or internal", async () => {
		const controller = new AbortController();
		const source = fetchDocs("https://docs.test", (_input, init) => {
			controller.abort();
			return Promise.reject(init?.signal?.reason ?? new Error("aborted"));
		});
		await expect(source("billing", controller.signal)).rejects.toMatchObject({
			code: "cancelled",
		});
	});
});

describe("capMarkdown", () => {
	it("keeps text under the cap as it is", () => {
		expect(capMarkdown("## A\n\nshort", "https://x.test/a")).toEqual({
			markdown: "## A\n\nshort",
			truncated: false,
		});
	});

	it("closes a code block it cuts through", () => {
		const long = [
			"## A",
			"",
			"```ts",
			...Array(2000).fill("const x = 1;"),
		].join("\n");
		const { markdown, truncated } = capMarkdown(long, "https://x.test/a#a");
		expect(truncated).toBe(true);
		expect(bytes(markdown)).toBeLessThanOrEqual(DOCS_MAX_BYTES);
		expect(markdown).toMatch(/\n```\n\nMore at https:\/\/x\.test\/a#a$/);
	});

	it("ignores headings inside code blocks", () => {
		const result = readDoc("# T\n\n## Real\n\n```md\n## Fake\n```\n", {
			page: "billing",
			baseUrl: "https://x.test",
		});
		expect(result).toMatchObject({ outline: ["## Real"] });
	});
});
