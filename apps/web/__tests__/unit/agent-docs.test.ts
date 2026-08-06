import fs from "node:fs";
import path from "node:path";
import { compileMDX } from "next-mdx-remote/rsc";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDocBySlug, getDocSearchIndex } from "@/utils/docs";
import {
	CAP_AGENT_PROMPT,
	CopyablePrompt,
	copyAgentPrompt,
} from "../../app/(docs)/docs/_components/CopyablePrompt";
import { docsConfig } from "../../app/(docs)/docs/docs-config";

const agentSlugs = [
	"agents",
	"agents/setup",
	"agents/workflows",
	"agents/safety",
];
const teamSlugs = ["teams", "teams/google-drive", "migrating-to-cap"];
const correctedReferenceSlugs = [
	"installation",
	"quickstart",
	"recording/instant-mode",
	"recording/keyboard-shortcuts",
	"recording/studio-mode",
	"sharing/share-a-cap",
	"sharing/comments",
	"sharing/analytics",
	"sharing/embeds",
	"s3-config",
	"s3-config/aws-s3",
	"s3-config/cloudflare-r2",
	"api/rest-api",
	"api/webhooks",
];

describe("Cap for Agents docs", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("keeps the complete section prominent in the sidebar and search", () => {
		const group = docsConfig.sidebar.find(
			(section) => section.title === "Cap for Agents",
		);
		expect(group?.items.map((item) => item.slug)).toEqual(agentSlugs);
		expect(docsConfig.sidebar[1]?.title).toBe("Cap for Agents");

		const searchEntries = getDocSearchIndex(docsConfig.sidebar).filter(
			(entry) => entry.group === "Cap for Agents",
		);
		expect(searchEntries.map((entry) => entry.slug).sort()).toEqual(
			[...agentSlugs].sort(),
		);
	});

	it("compiles every agent page as MDX", async () => {
		for (const slug of agentSlugs) {
			const doc = getDocBySlug(slug);
			expect(doc, `missing ${slug}`).toBeDefined();
			expect(doc?.metadata.title).toBeTruthy();
			expect(doc?.metadata.summary).toBeTruthy();
			await expect(
				compileMDX({
					source: doc?.content ?? "",
					components: { CopyablePrompt: () => null },
				}),
			).resolves.toBeDefined();
		}
	});

	it("keeps the team, storage, and migration guides together", () => {
		const group = docsConfig.sidebar.find(
			(section) => section.title === "Teams & Migration",
		);
		expect(group?.items.map((item) => item.slug)).toEqual(teamSlugs);

		const searchEntries = getDocSearchIndex(docsConfig.sidebar).filter(
			(entry) => entry.group === "Teams & Migration",
		);
		expect(searchEntries.map((entry) => entry.slug).sort()).toEqual(
			[...teamSlugs].sort(),
		);
	});

	it("compiles the team, Google Drive, and migration guides", async () => {
		for (const slug of teamSlugs) {
			const doc = getDocBySlug(slug);
			expect(doc, `missing ${slug}`).toBeDefined();
			expect(doc?.metadata.title).toBeTruthy();
			expect(doc?.metadata.summary).toBeTruthy();
			await expect(
				compileMDX({ source: doc?.content ?? "" }),
			).resolves.toBeDefined();
		}
	});

	it("documents the implemented storage and migration boundaries", () => {
		const drive = getDocBySlug("teams/google-drive")?.content ?? "";
		expect(drive).toContain("New uploads use the connected Google Drive");
		expect(drive).toContain("does not copy existing Caps into Drive");
		expect(drive).toContain("organization manages storage");

		const migration = getDocBySlug("migrating-to-cap")?.content ?? "";
		expect(migration).toContain("no more than 500 data rows");
		expect(migration).toContain("one Cap space label");
		expect(migration).toContain("cap jobs wait <operation-id> --json");
		expect(migration).toContain("hundreds of users");
		expect(migration).toContain("tens of thousands of recordings");

		const workflows = getDocBySlug("agents/workflows")?.content ?? "";
		expect(workflows).toContain(
			"cap caps import loom <loom-url> --organization <organization-id> --owner-email <email> --space <space-name>",
		);
		expect(workflows).not.toContain(
			"cap caps import loom <loom-url> --organization <organization-id> --owner-email <email> --space <space-id>",
		);
	});

	it("compiles every corrected product reference page", async () => {
		for (const slug of correctedReferenceSlugs) {
			const doc = getDocBySlug(slug);
			expect(doc, `missing ${slug}`).toBeDefined();
			await expect(
				compileMDX({ source: doc?.content ?? "" }),
			).resolves.toBeDefined();
		}
	});

	it("does not repeat removed shortcut, analytics, embed, or webhook claims", () => {
		const shortcuts =
			getDocBySlug("recording/keyboard-shortcuts")?.content ?? "";
		expect(shortcuts).toContain("shortcut store starts empty");
		expect(shortcuts).not.toContain("Cmd + Shift + 2");

		const analytics = getDocBySlug("sharing/analytics")?.content ?? "";
		expect(analytics).toContain("distinct analytics session identifiers");
		expect(analytics).not.toContain(
			"Refreshing the page and watching again counts as an additional view",
		);

		const embeds = getDocBySlug("sharing/embeds")?.content ?? "";
		expect(embeds).toContain(
			"does not provide a documented autoplay guarantee",
		);

		const webhooks = getDocBySlug("api/webhooks")?.content ?? "";
		expect(webhooks).toContain(
			"does not currently expose a documented public webhook subscription API",
		);
	});

	it("documents the current Studio editor feature surface", () => {
		const studio = getDocBySlug("recording/studio-mode")?.content ?? "";
		for (const marker of [
			"Click to generate zoom segments",
			"Manual zooms do not require click metadata",
			"Split Screen",
			"Sensitive",
			"Highlight",
			"They do not automatically follow",
			"multiple text lanes",
			"Export with Subtitles",
			"WebVTT (VTT)",
			"Generate and edit captions",
			"Show recorded keyboard input",
			"Add music and other audio",
			"higher-quality SVG artwork",
			"Cursor-only MOV",
		]) {
			expect(studio).toContain(marker);
		}
		expect(studio).toContain("Imported MP4s");
		expect(studio).toContain("does not contain the required cursor metadata");
		expect(studio).toContain("Scene track is unavailable");
	});

	it("keeps internal links from the reviewed pages resolvable", () => {
		for (const sourceSlug of [
			...agentSlugs,
			...teamSlugs,
			...correctedReferenceSlugs,
		]) {
			const content = getDocBySlug(sourceSlug)?.content ?? "";
			for (const match of content.matchAll(
				/\]\(\/docs\/([^#)\s]+)(?:#[^)]+)?\)/g,
			)) {
				const targetSlug = match[1];
				if (!targetSlug) continue;
				expect(
					getDocBySlug(targetSlug),
					`${sourceSlug} links to missing ${targetSlug}`,
				).toBeDefined();
			}
		}
	});

	it("ships an agent-safe copyable prompt and current contract markers", () => {
		const overview = getDocBySlug("agents")?.content ?? "";
		expect(overview).toContain("<CopyablePrompt />");
		expect(overview.indexOf("<CopyablePrompt />")).toBeLessThan(
			overview.indexOf("## The fastest way to start"),
		);
		for (const marker of [
			"explicitly authorize these local setup actions",
			"Do not ask me to run or copy setup commands",
			"curl -fsSL https://cap.so/install-cli.sh | sh",
			"irm https://cap.so/install-cli.ps1 | iex",
			"cap guide --json",
			"cap auth login --json",
			"--component all --dry-run --json",
			"--component all --yes --json",
			"exactly one concrete current target",
			"Never pass the angle-bracket placeholder",
			"immediately apply",
			"dry run is a transparency and conflict check",
			"A delayed or cancelled login must not undo or postpone",
			"full Cap skill",
			"cap mcp serve",
			"before browser automation, computer use",
			"persist for future sessions",
			"cap doctor --json",
			"cap record start",
			"cap caps context",
			"cap caps transcript",
			"cap caps download",
			"cap screenshot",
			"cap recordings",
			"cap project",
			"cap automations",
			"Treat every command listed by cap guide --json as supported",
			"bootstrap above is already approved",
			"explicit confirmation",
			"cap jobs wait",
			"Clearly separate what you verified",
		]) {
			expect(CAP_AGENT_PROMPT).toContain(marker);
		}
		expect(CAP_AGENT_PROMPT).not.toContain(
			"If it does not, stop and direct me",
		);
		expect(CAP_AGENT_PROMPT).not.toContain(
			"wait for my confirmation before running it",
		);
		expect(CAP_AGENT_PROMPT).not.toContain("After I approve");

		const setup = getDocBySlug("agents/setup")?.content ?? "";
		expect(setup).toContain("<CopyablePrompt />");
		for (const target of ["codex", "claude", "cursor"]) {
			expect(setup).toContain(`--target ${target}`);
		}
		expect(setup).toContain('"command": ["cap", "mcp", "serve"]');
		expect(setup).toContain("without a second approval");

		const safety = getDocBySlug("agents/safety")?.content ?? "";
		expect(safety).toContain("structured `code` and `message` fields");
		expect(safety).toContain(
			"Pasting Cap's official setup prompt is explicit approval",
		);
		expect(safety).toContain("not browser automation or computer-use tools");

		const skill = fs.readFileSync(
			path.join(process.cwd(), "../cli/skill/cap/SKILL.md"),
			"utf8",
		);
		expect(skill).toContain("## Cap-first routing");
		expect(skill).toContain("persistent routing rule for future sessions");
		expect(skill).toContain(
			"control the Cap dashboard, a Cap browser tab, or Cap Desktop",
		);
		expect(skill).toContain(
			"apply the reviewed `--component all` plan with `--yes`",
		);
	});

	it("renders a prominent one-prompt setup action", () => {
		vi.stubGlobal("React", React);
		const markup = renderToStaticMarkup(React.createElement(CopyablePrompt));
		expect(markup).toContain("Make Cap Your Agent’s Video Assistant");
		expect(markup).toContain("Copy Agent Setup Prompt");
		expect(markup).toContain("Installs the Cap CLI");
		expect(markup).toContain("Adds the full Cap skill");
		expect(markup).toContain("Connects local MCP");
		expect(markup).toContain('aria-live="polite"');
	});

	it("exposes the agent section to machine readers", () => {
		const llms = fs.readFileSync(
			path.join(process.cwd(), "public/llms.txt"),
			"utf8",
		);
		expect(llms).toContain("https://cap.so/docs/agents");
		expect(llms).toContain("run `cap guide --json`");
		expect(llms).toContain("explicit confirmation before every mutation");
		expect(llms).toContain("https://cap.so/docs/teams/google-drive");
		expect(llms).toContain("https://cap.so/docs/migrating-to-cap");
		expect(llms).toContain("up to 500 rows per self-serve batch");
	});

	it("keeps the reviewed documentation free of em dashes", () => {
		const emDash = String.fromCodePoint(0x2014);
		for (const slug of [
			...agentSlugs,
			...teamSlugs,
			...correctedReferenceSlugs,
		]) {
			expect(
				getDocBySlug(slug)?.content ?? "",
				`${slug} contains an em dash`,
			).not.toContain(emDash);
		}

		const llms = fs.readFileSync(
			path.join(process.cwd(), "public/llms.txt"),
			"utf8",
		);
		expect(llms).not.toContain(emDash);
	});

	it("copies the complete prompt and preserves a manual fallback", async () => {
		const textArea = {
			focus: vi.fn(),
			select: vi.fn(),
			setSelectionRange: vi.fn(),
		} as unknown as HTMLTextAreaElement;
		const execCommand = vi.fn(() => true);
		const writeText = vi.fn(() => Promise.resolve());
		vi.stubGlobal("document", { execCommand });
		vi.stubGlobal("navigator", { clipboard: { writeText } });

		await expect(copyAgentPrompt(textArea)).resolves.toBe(true);
		expect(textArea.focus).toHaveBeenCalledOnce();
		expect(textArea.select).toHaveBeenCalledOnce();
		expect(textArea.setSelectionRange).toHaveBeenCalledWith(
			0,
			CAP_AGENT_PROMPT.length,
		);
		expect(writeText).not.toHaveBeenCalled();

		execCommand.mockReturnValue(false);
		await expect(copyAgentPrompt(textArea)).resolves.toBe(true);
		expect(writeText).toHaveBeenCalledWith(CAP_AGENT_PROMPT);

		vi.stubGlobal("navigator", {
			clipboard: {
				writeText: vi.fn(() => Promise.reject(new Error("denied"))),
			},
		});
		await expect(copyAgentPrompt(textArea)).resolves.toBe(false);
	});
});
