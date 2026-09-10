"use client";

import { classNames } from "@cap/utils/helpers";
import { Check } from "lucide-react";
import { useState } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { Eyebrow } from "@/components/pages/HomeTwo/Eyebrow";
import {
	BAND,
	BODY_TEXT,
	GRAIN,
	grainBg,
	H_SECTION,
	MODE_THEME,
	MONO,
	meshStyle,
} from "@/components/pages/HomeTwo/theme";
import { CAP_AGENT_PROMPT } from "@/data/agent-prompt";
import { POINTER_PROMPT, setupSteps } from "./content";
import { CopyLabelButton, Snippet } from "./copy";

const DARK = {
	backgroundColor: "#111111",
	backgroundImage: GRAIN,
	backgroundSize: "200px 200px",
} as const;

const BENEFITS = [
	"Installs the Cap CLI",
	"Adds the Cap skill",
	"Connects local MCP",
	"Verifies access",
];

const TOGGLE =
	"rounded-full border border-white/15 bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-medium text-white/80 transition-colors duration-200 hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white";

export const SetupPrompt = () => {
	const [expanded, setExpanded] = useState(false);

	return (
		// biome-ignore lint/correctness/useUniqueElementIds: stable anchor target for the hero's "See how it works" link
		<section id="setup" className="scroll-mt-24 px-5 py-20 lg:py-28">
			<div className="mx-auto max-w-[1200px]">
				<div className="max-w-[760px]">
					<Eyebrow accent={MODE_THEME.instant.accent}>One prompt</Eyebrow>
					<h2
						className={`${H_SECTION} mt-6 text-balance text-[clamp(36px,4.6vw,56px)]`}
					>
						Set up Cap with one paste
					</h2>
					<p
						className={`${BODY_TEXT} mt-6 max-w-[640px] text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[17.5px]`}
					>
						Copy the prompt, paste it into your agent, and let it do the rest.
						It installs the Cap CLI, adds the Cap skill and a local MCP server
						for the agent you are using, signs you in with the least privilege
						it needs, and verifies everything before it starts. If you would
						rather not paste anything, just point your agent at this page.
					</p>
				</div>

				<div className="mt-12 grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
					<div
						className="flex flex-col rounded-[20px] p-4 lg:p-5"
						style={grainBg(BAND)}
					>
						<div className="flex flex-wrap items-center justify-between gap-3 px-1 pt-1">
							<span
								className={classNames(
									MONO,
									"text-[11px] uppercase leading-none tracking-[0.05em] text-[rgba(17,17,17,0.5)]",
								)}
							>
								Cap agent setup prompt
							</span>
							<CopyLabelButton
								text={CAP_AGENT_PROMPT}
								copiedLabel="Copied to clipboard"
								onCopy={() =>
									trackEvent("agents_prompt_copied", {
										source_page: "agents_setup",
										cta_location: "prompt_card",
										variant: "full",
									})
								}
								className="inline-flex h-10 items-center justify-center rounded-full bg-[#111111] px-4 text-[14px] font-medium text-white transition-colors duration-200 hover:bg-[#2A2A2A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-2"
							>
								Copy prompt
							</CopyLabelButton>
						</div>

						<div
							className="relative mt-4 flex flex-1 flex-col overflow-hidden rounded-[14px]"
							style={DARK}
						>
							<div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
								<span className="size-2 rounded-full bg-[#FF5F57]" />
								<span className="size-2 rounded-full bg-[#FEBC2E]" />
								<span className="size-2 rounded-full bg-[#28C840]" />
								<span
									className={classNames(
										MONO,
										"ml-3 truncate text-[11px] uppercase tracking-[0.05em] text-[rgba(255,255,255,0.45)]",
									)}
								>
									paste into claude code · codex · cursor · opencode
								</span>
							</div>
							<pre
								className={classNames(
									MONO,
									"m-0 whitespace-pre-wrap px-4 pb-6 pt-4 text-[12.5px] leading-[1.7] text-[rgba(255,255,255,0.82)] selection:bg-[#2E6BE573] sm:px-5",
									expanded
										? ""
										: "max-h-[340px] overflow-hidden lg:max-h-[600px]",
								)}
							>
								{CAP_AGENT_PROMPT}
							</pre>
							{expanded ? (
								<div className="flex justify-center pb-4">
									<button
										type="button"
										onClick={() => setExpanded(false)}
										className={TOGGLE}
									>
										Show less
									</button>
								</div>
							) : (
								<div className="absolute inset-x-0 bottom-0 flex h-28 items-end justify-center rounded-b-[14px] bg-gradient-to-t from-[#111111] via-[#111111]/85 to-transparent pb-4">
									<button
										type="button"
										onClick={() => setExpanded(true)}
										className={TOGGLE}
									>
										Show full prompt
									</button>
								</div>
							)}
						</div>

						<ul className="mt-4 flex flex-wrap gap-2 px-1 pb-1">
							{BENEFITS.map((benefit) => (
								<li
									key={benefit}
									className="flex items-center gap-1.5 rounded-full bg-white py-1.5 pl-2.5 pr-3 text-[13px] leading-none text-[rgba(17,17,17,0.75)] shadow-[0_0_0_1px_rgba(17,17,17,0.06)]"
								>
									<Check
										aria-hidden="true"
										className="size-3.5 shrink-0 text-[#1B6E45]"
										strokeWidth={2.5}
									/>
									{benefit}
								</li>
							))}
						</ul>
					</div>

					<div className="flex flex-col gap-4">
						<ol
							className="rounded-[20px] px-6 py-2 lg:px-7"
							style={grainBg(BAND)}
						>
							{setupSteps.map((step, i) => (
								<li
									key={step.name}
									className="flex gap-5 border-t border-[#E1E7EE] py-6 first:border-t-0"
								>
									<span
										className={classNames(
											MONO,
											"mt-1 shrink-0 text-[12px] leading-none tracking-[0.05em] text-[rgba(17,17,17,0.45)]",
										)}
									>
										{String(i + 1).padStart(2, "0")}
									</span>
									<div>
										<h3 className="text-[19px] font-normal leading-[1.1] tracking-[-0.02em] text-[#111111]">
											{step.name}
										</h3>
										<p
											className={`${BODY_TEXT} mt-2 text-[14.5px] leading-[1.5] text-[rgba(17,17,17,0.7)]`}
										>
											{step.text}
										</p>
									</div>
								</li>
							))}
						</ol>

						<div
							className="flex flex-1 flex-col rounded-[20px] p-6 lg:p-7"
							style={meshStyle(MODE_THEME.instant)}
						>
							<Eyebrow accent="#111111">Point your agent here</Eyebrow>
							<h3 className="mt-4 text-[22px] font-normal leading-[1.1] tracking-[-0.02em] text-[#111111]">
								Prefer not to paste a wall of text?
							</h3>
							<p
								className={`${BODY_TEXT} mt-2.5 text-[14.5px] leading-[1.5] text-[rgba(17,17,17,0.75)]`}
							>
								This page is written for agents as well as people. Send your
								agent the link and it will find the setup prompt, the install
								steps for its own harness, and the operating instructions in the
								docs on its own.
							</p>
							<Snippet
								lines={[POINTER_PROMPT]}
								label="one-line prompt"
								prompt={false}
								onCopy={() =>
									trackEvent("agents_prompt_copied", {
										source_page: "agents_setup",
										cta_location: "pointer_card",
										variant: "pointer",
									})
								}
								className="mt-5"
							/>
							<p
								className={classNames(
									MONO,
									"mt-4 text-[11px] uppercase leading-[1.6] tracking-[0.05em] text-[rgba(17,17,17,0.5)]",
								)}
							>
								Agents reading this page: the setup prompt above is your
								operating instruction set. Continue at cap.so/docs/agents.
							</p>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
};
