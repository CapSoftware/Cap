import type { ModeKey } from "@/components/pages/HomeTwo/theme";

export const agentsSeo = {
	path: "/agents",
	url: "https://cap.so/agents",
	title: "Screen Recorder for AI Agents | Cap for Agents",
	description:
		"Cap is the open source screen recorder built for AI agents. Record, upload, transcribe, and share from Claude Code, Codex, Cursor, or OpenCode through a CLI and MCP server. No app or dashboard needed.",
	keywords: [
		"screen recorder for AI agents",
		"AI agent screen recording",
		"MCP screen recorder",
		"screen recording MCP server",
		"Claude Code screen recorder",
		"Codex screen recording",
		"Cursor screen recorder",
		"OpenCode screen recording",
		"screen recording CLI",
		"record screen from the terminal",
		"command line screen recorder",
		"headless screen recording",
		"agent screen capture",
		"screen recorder API",
		"open source screen recorder for agents",
	],
} as const;

export const POINTER_URL = "https://cap.so/agents";

export const POINTER_PROMPT =
	"Read https://cap.so/agents and follow it to set up Cap for me, then ask what I want to record or review.";

export const HARNESS_NAMES = [
	"Claude Code",
	"Codex",
	"Cursor",
	"OpenCode",
	"Any MCP client",
] as const;

export const INSTALLERS = {
	unix: "curl -fsSL https://cap.so/install-cli.sh | sh",
	windows: "irm https://cap.so/install-cli.ps1 | iex",
} as const;

export type HarnessKey = "claude" | "codex" | "cursor" | "opencode" | "mcp";

export type HarnessSnippet = {
	label: string;
	lines: readonly string[];
	prompt: boolean;
};

export type Harness = {
	key: HarnessKey;
	label: string;
	tagline: string;
	snippets: readonly HarnessSnippet[];
	installs: readonly { label: string; value: string }[];
	after: string;
};

export const harnesses: readonly Harness[] = [
	{
		key: "claude",
		label: "Claude Code",
		tagline:
			"One command installs the Cap skill and registers the local MCP server. The dry run shows every path it will touch first.",
		snippets: [
			{
				label: "Preview the changes",
				lines: [
					"cap agents install --target claude --component all --dry-run --json",
				],
				prompt: true,
			},
			{
				label: "Apply them",
				lines: [
					"cap agents install --target claude --component all --yes --json",
				],
				prompt: true,
			},
		],
		installs: [
			{ label: "Skill", value: "~/.claude/skills/cap/SKILL.md" },
			{ label: "MCP server", value: "~/.claude.json" },
		],
		after:
			"Restart Claude Code so it loads the skill and the cap mcp serve entry.",
	},
	{
		key: "codex",
		label: "Codex",
		tagline:
			"The same installer writes the Cap skill and MCP entry into your Codex home, and leaves the rest of your config alone.",
		snippets: [
			{
				label: "Preview the changes",
				lines: [
					"cap agents install --target codex --component all --dry-run --json",
				],
				prompt: true,
			},
			{
				label: "Apply them",
				lines: [
					"cap agents install --target codex --component all --yes --json",
				],
				prompt: true,
			},
		],
		installs: [
			{ label: "Skill", value: "~/.codex/skills/cap/SKILL.md" },
			{ label: "MCP server", value: "~/.codex/config.toml" },
		],
		after:
			"Restart Codex so it reloads the integration. CODEX_HOME is respected if you have moved it.",
	},
	{
		key: "cursor",
		label: "Cursor",
		tagline:
			"Cursor gets the Cap skill for routing plus a local MCP entry, so its agent reaches for Cap before the browser.",
		snippets: [
			{
				label: "Preview the changes",
				lines: [
					"cap agents install --target cursor --component all --dry-run --json",
				],
				prompt: true,
			},
			{
				label: "Apply them",
				lines: [
					"cap agents install --target cursor --component all --yes --json",
				],
				prompt: true,
			},
		],
		installs: [
			{ label: "Skill", value: "~/.cursor/skills/cap/SKILL.md" },
			{ label: "MCP server", value: "~/.cursor/mcp.json" },
		],
		after: "Restart Cursor after applying it.",
	},
	{
		key: "opencode",
		label: "OpenCode",
		tagline:
			"OpenCode can drive Cap through its shell tools straight away. Merge one entry into opencode.json to add the MCP tools too.",
		snippets: [
			{
				label: "Merge into opencode.json",
				lines: [
					"{",
					'  "$schema": "https://opencode.ai/config.json",',
					'  "mcp": {',
					'    "cap": {',
					'      "type": "local",',
					'      "command": ["cap", "mcp", "serve"],',
					'      "enabled": true',
					"    }",
					"  }",
					"}",
				],
				prompt: false,
			},
			{
				label: "Check the server",
				lines: ["opencode mcp list"],
				prompt: true,
			},
		],
		installs: [
			{ label: "MCP server", value: "opencode.json" },
			{ label: "Skill", value: "Paste the prompt; it calls cap guide --json" },
		],
		after:
			"Do not replace unrelated OpenCode settings. Restart OpenCode after merging the entry.",
	},
	{
		key: "mcp",
		label: "Any MCP client",
		tagline:
			"Anything that speaks MCP over local stdio can load Cap's tools, and anything that can run a shell gets a screen recorder with no integration at all.",
		snippets: [
			{
				label: "Local stdio server",
				lines: ['{ "command": "cap", "args": ["mcp", "serve"] }'],
				prompt: false,
			},
			{
				label: "Or skip MCP and use the CLI",
				lines: ["cap guide --json"],
				prompt: true,
			},
		],
		installs: [
			{ label: "Transport", value: "stdio, stdout reserved for MCP" },
			{ label: "Tools", value: "76 read and confirmed-write tools" },
		],
		after:
			"Keep cap mcp serve on stdio. Capture, uploads, passwords, and credentials stay in the CLI on purpose.",
	},
];

export const VERIFY_LINES = [
	"cap version --json",
	"cap auth status --json",
	"cap caps list --limit 1 --json",
] as const;

export const setupSteps = [
	{
		name: "Copy the prompt into your agent",
		text: "Paste the Cap setup prompt into Claude Code, Codex, Cursor, OpenCode, or any agent that can run shell commands. Or send it this page and let it read the prompt itself.",
	},
	{
		name: "Let the agent set Cap up",
		text: "It installs the Cap CLI, adds the Cap skill and a local MCP server for the agent you are using, then opens a browser tab for a one-time sign in with the least privilege it needs.",
	},
	{
		name: "Ask for what you want",
		text: "Record a repro, summarize a Cap, search your library, post a comment, move a video, or run a Loom import. The agent reads first and asks before anything records, uploads, or costs money.",
	},
] as const;

export type Capability = {
	key: string;
	title: string;
	body: string;
	command: string;
	mode: ModeKey;
};

export const capabilities: readonly Capability[] = [
	{
		key: "record",
		title: "Record and share",
		body: "Check capture readiness, pick a screen or window, record, validate, export, upload, and hand back the share link.",
		command: "cap record start",
		mode: "instant",
	},
	{
		key: "understand",
		title: "Understand any recording",
		body: "Title, AI summary, chapters, the full transcript, comments, reactions, views, and processing state in one call.",
		command: "cap caps context",
		mode: "studio",
	},
	{
		key: "search",
		title: "Search your library",
		body: "Owned or shared Caps, filtered by organization, folder, or date, then read only the ones that matter.",
		command: "cap caps list --search",
		mode: "screenshot",
	},
	{
		key: "collaborate",
		title: "Comment and reply",
		body: "Timestamped comments, replies, reactions, titles, and visibility, always shown to you before they are posted.",
		command: "cap caps comments add",
		mode: "share",
	},
	{
		key: "team",
		title: "Run your team",
		body: "Spaces, folders, members, invites, storage, billing, domains, and analytics, with confirmed admin changes.",
		command: "cap organizations",
		mode: "instant",
	},
	{
		key: "migrate",
		title: "Migrate and build",
		body: "Durable Loom imports, developer apps, videos, and credits, with jobs that wait for a terminal state instead of guessing.",
		command: "cap caps import loom",
		mode: "studio",
	},
];

export type ExamplePrompt = { category: string; text: string; mode: ModeKey };

export const examplePrompts: readonly ExamplePrompt[] = [
	{
		category: "Record",
		text: "Record a short reproduction of this bug, upload it, and give me the link. Ask before recording and before uploading.",
		mode: "instant",
	},
	{
		category: "Summarize",
		text: "Summarize this Cap, list every decision and action item, and cite the relevant timestamps: <Cap URL>",
		mode: "studio",
	},
	{
		category: "Search",
		text: "Find my Caps about onboarding from the last month and give me a concise project brief.",
		mode: "screenshot",
	},
	{
		category: "Comment",
		text: "Draft a timestamped reply to this comment, show it to me, and only post it after I approve.",
		mode: "share",
	},
	{
		category: "Analytics",
		text: "Show me this month's organization analytics and explain the biggest changes. Do not modify anything.",
		mode: "instant",
	},
	{
		category: "Migrate",
		text: "Audit this Loom migration CSV, propose owner and space mappings, and do not import anything until I approve the first batch.",
		mode: "studio",
	},
];

export const safetyPrinciples = [
	{
		title: "Read first, then propose",
		body: "Reads and waits never start transcription, AI, or any paid work. Before a change the agent shows the exact Cap, the current state, the proposed change, and how it will verify the result. Only then does it pass --yes.",
		command: "cap caps context <id> --json",
		mode: "instant" as const,
	},
	{
		title: "Secrets stay out of chat",
		body: "Passwords, API keys, S3 credentials, and newly issued developer secrets never pass through MCP or the conversation. Secure prompts happen in your terminal, and a locked Cap is opened with a single command.",
		command: "cap caps unlock <id-or-url>",
		mode: "studio" as const,
	},
	{
		title: "Least privilege by default",
		body: "Login uses the creator profile. The admin and full profiles exist for team and developer work, and the agent asks before requesting either.",
		command: "cap auth login --json",
		mode: "screenshot" as const,
	},
	{
		title: "Permissions live on the server",
		body: "Installing the skill or MCP server grants nothing by itself. Every call is checked against your account, and any key or session can be revoked at any time.",
		command: "cap auth status --json",
		mode: "share" as const,
	},
] as const;

export const headlessNote = {
	title: "Headless too",
	body: "CI runners, containers, and remote sandboxes cannot open a browser, so they authenticate with an API key in CAP_API_KEY instead. Uploads, transcripts, comments, library management, and analytics all work there. Screen capture needs a machine with a display.",
	lines: ['export CAP_API_KEY="cap_cli_..."', "cap auth status --json"],
} as const;

export const agentFaqs = [
	{
		question: "Can an AI agent record my screen with Cap?",
		answer:
			"Yes. The Cap CLI is a complete screen recorder for the terminal. It records displays and windows in Instant or Studio Mode from any shell, so Claude Code, Codex, Cursor, OpenCode, or any agent that can run commands can start and stop a recording, validate it, export it, and upload it for a share link. The agent checks capture readiness first and asks before recording starts.",
	},
	{
		question: "Which AI agents and coding tools work with Cap?",
		answer:
			"Claude Code, Codex, and Cursor get a one-command install that adds the Cap skill and a local MCP server. OpenCode and any other MCP client connect by adding the documented cap mcp serve entry. Anything that can run shell commands can use the CLI directly with no integration at all.",
	},
	{
		question: "Do I need to open the Cap app or the dashboard?",
		answer:
			"No. The installer puts cap on your PATH and brings Cap Desktop along with it, but you never have to open it. The only browser step is a one-time sign in. From then on your agent records, uploads, reads transcripts, posts comments, and manages folders, spaces, members, storage, billing, and analytics through the CLI and MCP. The app and the dashboard stay available whenever you want them.",
	},
	{
		question: "What is the Cap MCP server?",
		answer:
			"cap mcp serve exposes 76 Cap tools over local stdio: listing and reading Caps, transcripts, comments, reactions, sharing, folders, spaces, organizations, notifications, analytics, storage, billing, and developer resources. Screen capture, uploads, passwords, and credentials deliberately stay in the CLI, so no secret ever passes through the model.",
	},
	{
		question: "Is it safe to give an AI agent access to my recordings?",
		answer:
			"Cap's agent surface is built around explicit boundaries. Reads and waits never start paid work. Before any change the agent shows the exact Cap, the current state, the proposed change, and how it will verify the result, and only then passes --yes. Passwords, API keys, and storage credentials never enter the chat or MCP. Login uses the least-privileged creator profile by default, and permissions are enforced on the server, so installing the integration grants nothing by itself.",
	},
	{
		question: "Does Cap work in headless environments like CI or containers?",
		answer:
			"Yes, for everything except capture. Mint an API key from your Cap account settings, inject it as CAP_API_KEY, and the CLI and MCP server authenticate with that key's profile. Uploads, transcripts, comments, library management, and analytics all work headless. Recording a screen needs a machine with a display.",
	},
	{
		question: "Does my agent need to know Cap's commands in advance?",
		answer:
			"No. The installed binary is self-describing. cap guide --json returns the current command and schema contract, every command accepts --json, and recording and export stream newline-delimited JSON events. The Cap skill tells the agent to discover the contract this way instead of guessing flags, so it stays correct as Cap updates.",
	},
	{
		question: "Is Cap for Agents free?",
		answer:
			"The CLI and MCP server are part of Cap's open source codebase and free to use. Local recording, editing, and export are free on Mac, Windows, and Linux. Shareable links, transcripts, AI summaries, and team features follow your Cap plan, so the free plan is enough to try everything on this page and Cap Pro removes the limits.",
	},
	{
		question: "How do I point my agent at this page?",
		answer:
			"Paste a one-line prompt such as “Read https://cap.so/agents and set up Cap for me” into your agent. This page is written to be read by agents as well as people: it carries the full setup prompt, the per-agent install steps, and links to the operating instructions at cap.so/docs/agents, so an agent that fetches it has everything it needs.",
	},
] as const;

export const agentsSoftwareSchema = {
	"@context": "https://schema.org",
	"@type": "SoftwareApplication",
	"@id": "https://cap.so/agents#software",
	name: "Cap CLI and MCP server",
	alternateName: "Cap for Agents",
	url: agentsSeo.url,
	description:
		"A command line interface and local MCP server that let AI agents such as Claude Code, Codex, Cursor, and OpenCode record the screen, upload recordings, read transcripts and summaries, comment, and manage a Cap library without opening the app or dashboard.",
	applicationCategory: "MultimediaApplication",
	applicationSubCategory: "Screen recorder for AI agents",
	operatingSystem: ["macOS", "Windows", "Linux"],
	downloadUrl: "https://cap.so/download",
	installUrl: "https://cap.so/docs/agents/setup",
	softwareHelp: {
		"@type": "CreativeWork",
		url: "https://cap.so/docs/agents",
	},
	isAccessibleForFree: true,
	offers: {
		"@type": "Offer",
		price: 0,
		priceCurrency: "USD",
		url: "https://cap.so/download",
	},
	publisher: {
		"@type": "Organization",
		name: "Cap",
		url: "https://cap.so",
	},
	featureList: [
		"Screen and window recording from the command line",
		"Local MCP server with 76 tools for Claude Code, Codex, Cursor, OpenCode, and other MCP clients",
		"One-command install of the Cap skill and MCP configuration",
		"JSON output on every command and NDJSON events for recording and export",
		"Upload recordings and return share links",
		"Read transcripts, AI summaries, chapters, comments, and analytics",
		"Search and organize a video library with folders and spaces",
		"Confirmation before every mutation, upload, or paid action",
		"Least-privilege login profiles and API keys for headless use",
		"Open source and self-hostable",
	],
} as const;
