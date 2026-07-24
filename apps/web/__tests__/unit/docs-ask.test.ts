import { describe, expect, it } from "vitest";
import {
	buildDocsAskContext,
	buildDocsAskSystemPrompt,
	rankDocsForQuery,
	tokenizeQuery,
} from "@/lib/docs-ask";
import { getAllDocs } from "@/utils/docs";

describe("docs ask", () => {
	it("tokenizes questions into useful terms", () => {
		const terms = tokenizeQuery("How do I set up Cap in Claude Code?");
		expect(terms).toEqual(expect.arrayContaining(["set", "claude", "code"]));
		expect(terms).not.toContain("cap");
		expect(terms).not.toContain("how");
	});

	it("ranks agent docs first for agent setup questions", () => {
		const docs = getAllDocs();
		const ranked = rankDocsForQuery(
			"install the cli and connect claude code with mcp",
			docs,
		);
		expect(ranked.length).toBeGreaterThan(0);
		expect(ranked.slice(0, 3).map((doc) => doc.slug)).toContain("agents/setup");
	});

	it("builds a bounded context with matching sources", () => {
		const docs = getAllDocs();
		const { context, sources } = buildDocsAskContext(
			"record my screen from an agent",
			docs,
		);
		expect(sources.length).toBeGreaterThan(0);
		expect(sources.length).toBeLessThanOrEqual(6);
		expect(context.length).toBeLessThanOrEqual(30000);
		for (const source of sources) {
			expect(context).toContain(`/docs/${source.slug}`);
		}
	});

	it("falls back to core pages when nothing matches", () => {
		const docs = getAllDocs();
		const { sources } = buildDocsAskContext("zzzz qqqq", docs);
		expect(sources.map((source) => source.slug)).toContain("introduction");
	});

	it("writes the ask system prompt with page list and guardrails", () => {
		const prompt = buildDocsAskSystemPrompt({
			pages: [{ slug: "agents", title: "Cap for Agents" }],
			context: "# Cap for Agents\nPath: /docs/agents\n\nBody",
		});
		expect(prompt).toContain("- Cap for Agents: /docs/agents");
		expect(prompt).toContain("Never invent features");
		expect(prompt).toContain("hello@cap.so");
		expect(prompt).toContain("[Cap for Agents](/docs/agents)");
	});
});
