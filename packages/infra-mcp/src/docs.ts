import { z } from "zod";
import { LocalError } from "./errors";
import { timeLimit } from "./time";
import { type Tool, tool } from "./tool";

export const DOC_PAGES = [
	"get-started",
	"rest-api",
	"webhooks",
	"billing",
] as const;
export type DocPage = (typeof DOC_PAGES)[number];
export type DocsSource = (
	page: DocPage,
	signal: AbortSignal,
) => Promise<string>;

export const DOCS_MAX_BYTES = 8 * 1024;
export const DOCS_FETCH_TIMEOUT_MS = 10_000;
export const DOCS_CACHE_MS = 10 * 60_000;

type Heading = { level: number; text: string; anchor: string; line: number };

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.+)$/;
const encoder = new TextEncoder();
const bytesOf = (text: string) => encoder.encode(text).length;

export const docAnchor = (text: string) =>
	text
		.toLowerCase()
		.trim()
		.replace(/\s+/g, "-")
		.replace(/&/g, "-and-")
		.replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-");

const normalize = (text: string) =>
	text
		.toLowerCase()
		.replace(/[`*_]/g, "")
		.replace(/^\d+\.\s*/, "")
		.replace(/\s+/g, " ")
		.trim();

function headingsOf(lines: readonly string[]) {
	const headings: Heading[] = [];
	let fence: string | null = null;
	lines.forEach((line, index) => {
		const marker = FENCE.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length)
				fence = null;
			return;
		}
		if (marker) {
			fence = marker;
			return;
		}
		const match = HEADING.exec(line);
		if (!match?.[1] || !match[2]) return;
		const text = match[2].trim();
		headings.push({
			level: match[1].length,
			text,
			anchor: docAnchor(text),
			line: index,
		});
	});
	return headings;
}

function endOf(
	headings: readonly Heading[],
	index: number,
	total: number,
	sameOrHigher: boolean,
) {
	const start = headings[index];
	if (!start) return total;
	for (const next of headings.slice(index + 1)) {
		if (!sameOrHigher || next.level <= start.level) return next.line;
	}
	return total;
}

function findHeading(headings: readonly Heading[], section: string) {
	const wanted = normalize(section);
	const anchor = docAnchor(section.replace(/^#/, ""));
	const sections = headings.filter((heading) => heading.level >= 2);
	return (
		sections.find(
			(heading) =>
				normalize(heading.text) === wanted || heading.anchor === anchor,
		) ??
		(wanted === ""
			? undefined
			: sections.find((heading) => normalize(heading.text).includes(wanted)))
	);
}

const occurrences = (text: string, term: string) => {
	let count = 0;
	for (
		let at = text.indexOf(term);
		at >= 0 && count < 5;
		at = text.indexOf(term, at + term.length)
	)
		count++;
	return count;
};

function searchHeadings(
	lines: readonly string[],
	headings: readonly Heading[],
	query: string,
) {
	const phrase = normalize(query);
	const terms = [...new Set(phrase.match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu))];
	if (terms.length === 0) return [];
	return headings
		.map((heading, index) => ({ heading, index }))
		.filter(({ heading }) => heading.level >= 2)
		.map(({ heading, index }) => {
			const title = normalize(heading.text);
			const body = lines
				.slice(heading.line + 1, endOf(headings, index, lines.length, false))
				.join("\n")
				.toLowerCase();
			let score = title.includes(phrase) ? 20 : body.includes(phrase) ? 5 : 0;
			for (const term of terms) {
				score += (title.includes(term) ? 10 : 0) + occurrences(body, term);
			}
			return { heading, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((entry) => entry.heading);
}

export function capMarkdown(
	markdown: string,
	moreUrl: string,
	maxBytes = DOCS_MAX_BYTES,
) {
	if (bytesOf(markdown) <= maxBytes) return { markdown, truncated: false };
	const more = `More at ${moreUrl}`;
	let budget = maxBytes - bytesOf(`\n\n${more}`) - bytesOf("\n````");
	const kept: string[] = [];
	let fence: string | null = null;
	for (const line of markdown.split("\n")) {
		const size = bytesOf(line) + 1;
		if (size > budget) break;
		budget -= size;
		kept.push(line);
		const marker = FENCE.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length)
				fence = null;
		} else if (marker) fence = marker;
	}
	if (fence) kept.push(fence);
	return {
		markdown: `${kept.join("\n").trimEnd()}\n\n${more}`,
		truncated: true,
	};
}

export function readDoc(
	markdown: string,
	options: {
		page: DocPage;
		baseUrl: string;
		section?: string;
		query?: string;
	},
) {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const headings = headingsOf(lines);
	const pageUrl = `${options.baseUrl}/docs/api/${options.page}`;
	const title =
		headings.find((heading) => heading.level === 1)?.text ?? options.page;
	const outline = headings
		.filter((heading) => heading.level >= 2)
		.map((heading) => `${"#".repeat(heading.level)} ${heading.text}`);
	const base = { page: options.page, title, pageUrl };

	const sectionOf = (heading: Heading) => {
		const index = headings.indexOf(heading);
		const url = `${pageUrl}#${heading.anchor}`;
		const text = lines
			.slice(heading.line, endOf(headings, index, lines.length, true))
			.join("\n")
			.trim();
		return { ...base, section: heading.text, url, ...capMarkdown(text, url) };
	};

	const notFound = (message: string) => ({
		...base,
		found: false,
		message,
		outline,
		next: "Pass one of the outline headings as section, or other words as query.",
	});

	if (options.section !== undefined) {
		const heading = findHeading(headings, options.section);
		return heading
			? sectionOf(heading)
			: notFound(`No heading on this page matches "${options.section}".`);
	}

	if (options.query !== undefined) {
		const [best, ...others] = searchHeadings(lines, headings, options.query);
		if (!best) {
			return notFound(`Nothing on this page matches "${options.query}".`);
		}
		return {
			...sectionOf(best),
			...(others.length > 0
				? { otherMatches: others.slice(0, 3).map((heading) => heading.text) }
				: {}),
		};
	}

	const firstIndex = headings.findIndex((heading) => heading.level >= 2);
	const end =
		firstIndex < 0
			? lines.length
			: endOf(headings, firstIndex, lines.length, true);
	return {
		...base,
		outline,
		...capMarkdown(lines.slice(0, end).join("\n").trim(), pageUrl),
		next: "Pass one of the outline headings as section, or words to search for as query.",
	};
}

const unavailable = (pageUrl: string, status: number | null) =>
	new LocalError(
		"docs_unavailable",
		status === null
			? "The docs page could not be read"
			: `The docs page could not be read (status ${status})`,
		`Try again, or read ${pageUrl} directly.`,
	);

export function fetchDocs(
	baseUrl: string,
	fetcher: typeof fetch = (input, init) => fetch(input, init),
): DocsSource {
	const cache = new Map<DocPage, { text: string; at: number }>();
	return async (page, signal) => {
		const hit = cache.get(page);
		if (hit && Date.now() - hit.at < DOCS_CACHE_MS) return hit.text;
		const pageUrl = `${baseUrl}/docs/api/${page}`;
		const limit = timeLimit(DOCS_FETCH_TIMEOUT_MS, signal);
		let text: string;
		try {
			const response = await fetcher(`${pageUrl}.md`, {
				headers: { Accept: "text/markdown" },
				signal: limit.signal,
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw unavailable(pageUrl, response.status);
			}
			text = await response.text();
		} catch (error) {
			if (signal.aborted || error instanceof LocalError) throw error;
			throw unavailable(pageUrl, null);
		} finally {
			limit.dispose();
		}
		cache.set(page, { text, at: Date.now() });
		return text;
	};
}

export function createDocsTool(baseUrl: string, source: DocsSource): Tool {
	return tool({
		name: "docs_read",
		title: "Read the Cap Infra docs",
		description:
			"Read a section of the Cap Infra docs as Markdown: get-started (setup, upload, playback, the hosted player, MCP), rest-api (every endpoint and field, embed options, player events, errors, rate limits), webhooks (events, signature verification, retries) or billing (what is charged, credits, running out). Pass section with a heading, or query with words to search for. With neither, it returns the page outline and its first section. Free to call.",
		kind: "read",
		input: {
			page: z.enum(DOC_PAGES).describe("Which docs page to read"),
			section: z
				.string()
				.min(1)
				.max(200)
				.optional()
				.describe(
					"A heading on the page, matched without regard to case, such as Embed Options",
				),
			query: z
				.string()
				.min(1)
				.max(200)
				.optional()
				.describe(
					"Words to search the page for; returns the best matching section",
				),
		},
		run: async (args, call) => {
			if (args.section !== undefined && args.query !== undefined) {
				throw new LocalError(
					"invalid_arguments",
					"Pass section or query, not both",
					"Use section for a heading you know, or query to search.",
				);
			}
			return readDoc(await source(args.page, call.signal), {
				page: args.page,
				baseUrl,
				section: args.section,
				query: args.query,
			});
		},
	});
}
