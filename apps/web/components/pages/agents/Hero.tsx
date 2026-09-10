"use client";

import { classNames } from "@cap/utils/helpers";
import { ArrowDown, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { Eyebrow } from "@/components/pages/HomeTwo/Eyebrow";
import { AGENT } from "@/components/pages/HomeTwo/scenes";
import {
	LazyMount,
	useInView,
	useReducedMotion,
} from "@/components/pages/HomeTwo/scenes/engine";
import {
	BODY_TEXT,
	BTN_PRIMARY,
	BTN_SECONDARY,
	GRAIN,
	H_HERO,
	MODE_THEME,
	MONO,
} from "@/components/pages/HomeTwo/theme";
import { CAP_AGENT_PROMPT } from "@/data/agent-prompt";
import { ANCHORS, HARNESS_NAMES, POINTER_URL } from "./content";
import { CopyIconButton, CopyLabelButton } from "./copy";

const DARK = {
	backgroundColor: "#111111",
	backgroundImage: GRAIN,
	backgroundSize: "200px 200px",
} as const;

const SURFACES = [
	"CLI",
	"Local MCP server",
	"JSON on every command",
	"Skill for your agent",
];

export const Hero = () => {
	const [chapter, setChapter] = useState(0);
	const cardRef = useRef<HTMLDivElement | null>(null);
	const inView = useInView(cardRef);
	const reducedMotion = useReducedMotion();
	const playing = inView && !reducedMotion;

	return (
		<section className="relative px-5 pb-6 pt-12 sm:pt-14 lg:pb-8 lg:pt-[56px]">
			<div className="mx-auto max-w-[1200px]">
				<div className="relative mx-auto flex max-w-[900px] flex-col items-center text-center">
					<Eyebrow accent={MODE_THEME.studio.accent}>Cap for Agents</Eyebrow>
					<h1
						className={`${H_HERO} mt-6 text-balance text-[clamp(42px,6.4vw,84px)]`}
					>
						Give your agent a screen recorder.
					</h1>
					<p
						className={`${BODY_TEXT} mt-8 max-w-[700px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[19px]`}
					>
						Cap is the open source screen recorder built for AI agents. A CLI
						and a local MCP server let Claude Code, Codex, Cursor, OpenCode, or
						any agent that can run a shell record your screen, upload the
						result, read the transcript, and manage your whole library. No app
						to open. No dashboard to click through. Just ask.
					</p>

					<div className="mt-9 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
						<CopyLabelButton
							text={CAP_AGENT_PROMPT}
							copiedLabel="Prompt copied"
							onCopy={() =>
								trackEvent("agents_prompt_copied", {
									source_page: "agents_hero",
									cta_location: "primary",
									variant: "full",
								})
							}
							className={BTN_PRIMARY}
						>
							Copy the setup prompt
						</CopyLabelButton>
						<a
							href={`#${ANCHORS.setup}`}
							className={`${BTN_SECONDARY} group cursor-pointer gap-2.5`}
						>
							See how it works
							<span className="grid size-6 place-items-center rounded-full bg-[#E7EDF3] text-[rgba(17,17,17,0.65)] transition-colors duration-200 group-hover:bg-[#DCE4EC] group-hover:text-[#111111]">
								<ArrowDown className="size-3.5 transition-transform duration-200 group-hover:translate-y-[2px]" />
							</span>
						</a>
					</div>

					<div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-[14px] text-[rgba(17,17,17,0.55)]">
						<span>Or point your agent here</span>
						<span className="inline-flex items-center gap-0.5 rounded-full bg-white py-0.5 pl-3 pr-0.5 shadow-[0_0_0_1px_rgba(17,17,17,0.08)]">
							<span className={`${MONO} text-[13px] text-[#111111]`}>
								cap.so/agents
							</span>
							<CopyIconButton
								text={POINTER_URL}
								label="page link"
								onCopy={() =>
									trackEvent("agents_prompt_copied", {
										source_page: "agents_hero",
										cta_location: "pointer",
										variant: "url",
									})
								}
								className="size-7 rounded-full"
							/>
						</span>
					</div>

					<ul className="mt-7 flex flex-wrap items-center justify-center gap-x-1 gap-y-2">
						{HARNESS_NAMES.map((name, i) => (
							<li key={name} className="flex items-center gap-1">
								{i > 0 ? (
									<span
										aria-hidden="true"
										className="mx-1 size-[3px] rounded-full bg-[rgba(17,17,17,0.25)]"
									/>
								) : null}
								<span
									className={classNames(
										MONO,
										"text-[11.5px] uppercase leading-none tracking-[0.05em] text-[rgba(17,17,17,0.6)]",
									)}
								>
									{name}
								</span>
							</li>
						))}
					</ul>
					<span
						data-header-sentinel
						aria-hidden="true"
						className="pointer-events-none absolute bottom-0 left-0 size-px"
					/>
				</div>

				<div
					ref={cardRef}
					className="mt-12 rounded-[24px] p-4 lg:mt-14 lg:p-6"
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
			</div>
		</section>
	);
};
