import { CAP_AGENT_PROMPT } from "@/data/agent-prompt";

const fenceOf = (text: string) => {
	const longest = Math.max(
		2,
		...[...text.matchAll(/`+/g)].map(([run]) => run.length),
	);
	return "`".repeat(longest + 1);
};

const COPYABLE_PROMPT = /^<CopyablePrompt\s*\/>$/;
const CAP_EMBED = /^<CapEmbed\s+src="([^"]+)"\s*\/>$/;
const WARNING_OPEN = /^<Warning(?:\s+title="([^"]*)")?\s*>$/;
const WARNING_CLOSE = /^<\/Warning>$/;
const COMPONENT_TAG = /^<\/?[A-Z][\w.]*(?:\s[^>]*)?\/?>$/;
const MDX_COMMENT = /^\{\/\*[\s\S]*\*\/\}$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

const absoluteLinks = (line: string, origin: string) =>
	line.replace(/\]\(\/(?!\/)/g, `](${origin}/`);

export function docToMarkdown(
	doc: { metadata: { title: string; summary?: string }; content: string },
	origin: string,
) {
	const out: string[] = [`# ${doc.metadata.title}`, ""];
	if (doc.metadata.summary) out.push(doc.metadata.summary, "");

	let fence: string | null = null;
	let inWarning = false;
	const push = (line: string) =>
		out.push(inWarning ? (line ? `> ${line}` : ">") : line);

	for (const line of doc.content.split("\n")) {
		const marker = FENCE.exec(line)?.[1];
		if (fence) {
			push(line);
			if (marker && marker[0] === fence[0] && marker.length >= fence.length)
				fence = null;
			continue;
		}
		if (marker) {
			fence = marker;
			push(line);
			continue;
		}

		const trimmed = line.trim();
		if (COPYABLE_PROMPT.test(trimmed)) {
			const ticks = fenceOf(CAP_AGENT_PROMPT);
			push("Copy this setup prompt into your agent:");
			push("");
			push(`${ticks}text`);
			for (const promptLine of CAP_AGENT_PROMPT.split("\n")) push(promptLine);
			push(ticks);
			continue;
		}
		const embed = CAP_EMBED.exec(trimmed);
		if (embed) {
			push(`[Watch the video](${embed[1]})`);
			continue;
		}
		const warning = WARNING_OPEN.exec(trimmed);
		if (warning) {
			inWarning = true;
			push(`**${warning[1] || "Warning"}**`);
			push("");
			continue;
		}
		if (WARNING_CLOSE.test(trimmed)) {
			inWarning = false;
			continue;
		}
		if (MDX_COMMENT.test(trimmed) || COMPONENT_TAG.test(trimmed)) continue;

		push(absoluteLinks(line, origin));
	}

	return `${out.join("\n").trim()}\n`;
}
