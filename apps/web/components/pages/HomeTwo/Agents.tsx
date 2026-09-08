"use client";

import { classNames } from "@cap/utils/helpers";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { Eyebrow } from "./Eyebrow";
import { AGENT } from "./scenes";
import { LazyMount, useInView, useReducedMotion } from "./scenes/engine";
import {
	BAND,
	BODY_TEXT,
	BTN_SECONDARY,
	GRAIN,
	grainBg,
	H_SECTION,
	MODE_THEME,
	MONO,
} from "./theme";

const DARK = {
	backgroundColor: "#111111",
	backgroundImage: GRAIN,
	backgroundSize: "200px 200px",
} as const;

const SURFACES = ["CLI", "MCP server", "JSON on every command", "REST API"];

const FACTS = [
	{
		title: "One prompt to set up",
		body: "Paste one prompt from the docs and your agent installs the CLI, the Cap skill, and the MCP server for Claude Code, Cursor, or Codex.",
		snippet: "cap agents install --target claude --component all",
		mode: "instant" as const,
	},
	{
		title: "Every command speaks JSON",
		body: "Add one flag and the answer comes back as data. Recording and export stream NDJSON events as they happen.",
		snippet: "cap guide --json",
		mode: "studio" as const,
	},
	{
		title: "76 MCP tools, zero secrets",
		body: "Read and manage Caps, comments, sharing, and analytics over MCP. Capture and upload stay in the CLI, so no secret passes through the model.",
		snippet: "cap mcp serve",
		mode: "screenshot" as const,
	},
	{
		title: "Least privilege login",
		body: "Sign in with the creator profile by default, and the agent asks before anything records, uploads, or costs money.",
		snippet: "cap auth login",
		mode: "share" as const,
	},
];

type Tab = { key: "cli" | "mcp"; label: string; lines: string[]; note: string };

const CLI_TAB: Tab = {
	key: "cli",
	label: "CLI",
	lines: [
		"cap record start --screen 1 --mode instant --duration 20 --json",
		'cap upload ./recording.cap --export --name "Checkout bug repro" --json',
	],
	note: "Record in the background, stop it later, and upload a .cap or .mp4 for a link. Works from any shell, script, or agent tool call.",
};

const MCP_TAB: Tab = {
	key: "mcp",
	label: "MCP",
	lines: [
		"{",
		'  "mcpServers": {',
		'    "cap": { "command": "cap", "args": ["mcp", "serve"] }',
		"  }",
		"}",
	],
	note: "Point any MCP client at the Cap server and it gets 76 tools for listing, reading, commenting on, and sharing Caps. Capture and upload stay in the CLI.",
};

const TABS: Tab[] = [CLI_TAB, MCP_TAB];

export const Agents = () => {
	const [chapter, setChapter] = useState(0);
	const [tab, setTab] = useState(0);
	const cardRef = useRef<HTMLDivElement | null>(null);
	const inView = useInView(cardRef);
	const reducedMotion = useReducedMotion();
	const playing = inView && !reducedMotion;
	const active = TABS[tab] ?? CLI_TAB;

	return (
		<section className="px-5 py-20 lg:py-28">
			<div className="mx-auto max-w-[1200px]">
				<div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
					<Eyebrow accent={MODE_THEME.studio.accent}>Cap for Agents</Eyebrow>
					<h2
						className={`${H_SECTION} mt-6 text-balance text-[clamp(38px,5vw,56px)]`}
					>
						Your agent can record, share, and read Caps
					</h2>
					<p
						className={`${BODY_TEXT} mt-6 max-w-[640px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[17.5px]`}
					>
						Cap ships a CLI and a local MCP server, so Claude Code, Cursor,
						Codex, OpenCode, or any shell capable agent can record your screen,
						upload the result, and read back the transcript and summary. One
						pasted prompt installs everything, and the agent asks before
						anything records, uploads, or costs money.
					</p>
				</div>

				<div
					ref={cardRef}
					className="mt-14 rounded-[24px] p-4 lg:p-6"
					style={DARK}
				>
					<LazyMount w={1200} h={520}>
						<AGENT.Scene
							chapter={chapter}
							playing={playing}
							onChapterEnd={() =>
								setChapter((current) => (current + 1) % AGENT.chapters.length)
							}
						/>
					</LazyMount>
					<ul className="mt-5 flex flex-wrap items-center gap-2">
						{SURFACES.map((surface) => (
							<li
								key={surface}
								className={classNames(
									MONO,
									"rounded-full border border-white/15 px-3 py-1.5 text-[11px] uppercase leading-none tracking-[0.05em] text-[rgba(255,255,255,0.72)]",
								)}
							>
								{surface}
							</li>
						))}
						<li className="ml-auto">
							<Link
								href="/docs/agents"
								className={classNames(
									MONO,
									"flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-[11px] uppercase leading-none tracking-[0.05em] text-[#111111] transition-colors duration-200 hover:bg-[#EDF1F6]",
								)}
							>
								Agent docs
								<ArrowUpRight className="size-3" />
							</Link>
						</li>
					</ul>
				</div>

				<div className="mt-4 grid gap-4 lg:grid-cols-[1.05fr_1fr]">
					<ul className="grid gap-4 sm:grid-cols-2">
						{FACTS.map((fact) => {
							const theme = MODE_THEME[fact.mode];
							return (
								<li
									key={fact.title}
									className="flex flex-col justify-between rounded-[20px] p-6"
									style={grainBg(BAND)}
								>
									<div>
										<span
											aria-hidden="true"
											className="block size-[7px]"
											style={{ background: theme.accent }}
										/>
										<h3 className="mt-5 text-[19px] font-normal leading-[1.1] tracking-[-0.02em] text-[#111111]">
											{fact.title}
										</h3>
										<p
											className={`${BODY_TEXT} mt-2 text-[14.5px] leading-[1.45] text-[rgba(17,17,17,0.7)]`}
										>
											{fact.body}
										</p>
									</div>
									<code
										className={classNames(
											MONO,
											"mt-5 block whitespace-pre-wrap break-words rounded-[10px] bg-white px-3 py-2 text-[12px] leading-[1.6] text-[#111111] shadow-[0_0_0_1px_rgba(17,17,17,0.06)]",
										)}
									>
										<span className="text-[rgba(17,17,17,0.4)]">$ </span>
										{fact.snippet}
									</code>
								</li>
							);
						})}
					</ul>

					<div
						className="flex flex-col rounded-[20px] p-6"
						style={grainBg(BAND)}
					>
						<div className="flex items-center gap-1 self-start rounded-full bg-white p-1 shadow-[0_0_0_1px_rgba(17,17,17,0.06)]">
							{TABS.map((item, i) => (
								<button
									key={item.key}
									type="button"
									aria-pressed={i === tab}
									onClick={() => setTab(i)}
									className={classNames(
										"rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]",
										i === tab
											? "bg-[#111111] text-white"
											: "text-[rgba(17,17,17,0.6)] hover:text-[#111111]",
									)}
								>
									{item.label}
								</button>
							))}
						</div>
						<pre
							className={classNames(
								MONO,
								"mt-4 rounded-[14px] p-5 text-[12.5px] leading-[1.75] text-[#F8FAFC]",
							)}
							style={DARK}
						>
							{active.lines.map((line) => (
								<span
									key={line}
									className="block whitespace-pre-wrap break-words"
								>
									{active.key === "cli" ? (
										<span className="text-[rgba(255,255,255,0.4)]">$ </span>
									) : null}
									{line}
								</span>
							))}
						</pre>
						<p
							className={`${BODY_TEXT} mb-5 mt-4 text-[14.5px] leading-[1.45] text-[rgba(17,17,17,0.7)]`}
						>
							{active.note}
						</p>
						<Link
							href="/docs/agents"
							className={classNames(BTN_SECONDARY, "self-start")}
						>
							Read the agent docs
						</Link>
					</div>
				</div>
			</div>
		</section>
	);
};
