import type { Doc } from "@/utils/docs";

const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"how",
	"what",
	"why",
	"can",
	"does",
	"you",
	"your",
	"are",
	"cap",
	"docs",
	"use",
	"using",
	"from",
	"into",
	"about",
]);

export function tokenizeQuery(query: string): string[] {
	return Array.from(
		new Set(
			query
				.toLowerCase()
				.replace(/[^a-z0-9\s-]/g, " ")
				.split(/\s+/)
				.filter((term) => term.length > 2 && !STOP_WORDS.has(term)),
		),
	);
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1 && count < 12) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

export function rankDocsForQuery(query: string, docs: Doc[]): Doc[] {
	const terms = tokenizeQuery(query);
	if (terms.length === 0) return [];

	return docs
		.map((doc) => {
			const title = doc.metadata.title.toLowerCase();
			const summary = (doc.metadata.summary ?? "").toLowerCase();
			const slug = doc.slug.toLowerCase();
			const content = doc.content.toLowerCase();
			let score = 0;
			for (const term of terms) {
				if (title.includes(term)) score += 8;
				if (slug.includes(term)) score += 6;
				if (summary.includes(term)) score += 4;
				score += countOccurrences(content, term);
			}
			return { doc, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((entry) => entry.doc);
}

const CONTEXT_DOC_LIMIT = 6;
const CONTEXT_DOC_CHAR_LIMIT = 7000;
const CONTEXT_TOTAL_CHAR_LIMIT = 30000;
const FALLBACK_SLUGS = ["introduction", "quickstart", "agents"];

export interface DocsAskContext {
	context: string;
	sources: Array<{ slug: string; title: string }>;
}

export function buildDocsAskContext(
	query: string,
	docs: Doc[],
): DocsAskContext {
	const ranked = rankDocsForQuery(query, docs);
	const chosen = ranked.length
		? ranked
		: docs.filter((doc) => FALLBACK_SLUGS.includes(doc.slug));

	const sections: string[] = [];
	const sources: DocsAskContext["sources"] = [];
	let total = 0;

	for (const doc of chosen) {
		if (sources.length >= CONTEXT_DOC_LIMIT) break;
		const section = `# ${doc.metadata.title}\nPath: /docs/${doc.slug}\n\n${doc.content.slice(0, CONTEXT_DOC_CHAR_LIMIT)}`;
		if (total + section.length > CONTEXT_TOTAL_CHAR_LIMIT) break;
		sections.push(section);
		sources.push({ slug: doc.slug, title: doc.metadata.title });
		total += section.length;
	}

	return { context: sections.join("\n\n---\n\n"), sources };
}

export function buildDocsAskSystemPrompt({
	pages,
	context,
}: {
	pages: Array<{ slug: string; title: string }>;
	context: string;
}): string {
	const pageList = pages
		.map((page) => `- ${page.title}: /docs/${page.slug}`)
		.join("\n");

	return `You are Cap's documentation assistant, embedded in the search dialog on cap.so/docs. Cap is the open-source screen recording and sharing app for macOS and Windows, with a web app for sharing, a CLI, and agent integrations (Cap for Agents: CLI, skill, and local MCP).

Answer the user's question using only the documentation pages provided below.

Rules:
- Be direct and concise. Lead with the answer. Keep most answers under 150 words; use short numbered steps for how-to questions.
- Format with Markdown: **bold** for UI labels, \`inline code\` for commands and flags, fenced code blocks for multi-line commands.
- When you reference a docs page, link it inline with its relative path, like [Set Up Your Agent](/docs/agents/setup). Only link paths from the page list below. Never invent URLs.
- If the docs do not answer the question, say so plainly, point to the closest relevant page, and suggest emailing hello@cap.so. Never invent features, commands, flags, prices, or limits.
- If the user wants to connect Cap to an AI agent (Claude Code, Codex, Cursor, OpenCode, or any MCP client), point them to the one-prompt setup on [Cap for Agents](/docs/agents) first.
- Only answer questions about Cap and its documentation. For anything else, politely say you can only help with Cap.

All documentation pages:
${pageList}

Documentation content for this question:
${context}`;
}
