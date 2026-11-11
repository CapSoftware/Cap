import Link from "next/link";
import {
	CAP_INFRA_AGENT_PROMPT,
	CAP_INFRA_POINTER_PROMPT,
} from "@/data/infra-agent-prompt";
import { CopyPointerButton, CopyPromptButton } from "./AgentCopy";
import { AGENT_STEPS, AGENT_TOOLS, ANCHORS, LINKS } from "./content";
import { Section, SectionHeading } from "./shared";
import { BTN_GHOST, MONO, TEXT_LINK } from "./theme";

const PROMPT_OPENING = CAP_INFRA_AGENT_PROMPT.split("\n")[0];

const RULE = "border-[rgba(222,230,246,0.07)]";

export const Agent = () => (
	<Section id={ANCHORS.agents} className="pt-20 lg:pt-28">
		<div className="grid gap-x-16 gap-y-8 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:grid-rows-[auto_1fr]">
			<SectionHeading title="Bring your agent.">
				<p>
					One prompt sets up Cap Infra in your project. Your agent installs the
					Cap CLI, creates an app, stores the keys and wires up uploads and
					playback.
				</p>
			</SectionHeading>
			<div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
				<div className="overflow-hidden rounded-[12px] bg-[rgba(222,230,246,0.022)] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.08)]">
					<div className="flex flex-col gap-x-8 gap-y-6 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-7">
						<div className="min-w-0">
							<p
								className={`${MONO} m-0 max-w-[400px] text-pretty text-[14px] leading-[1.6] text-[#E8ECF4]`}
							>
								{PROMPT_OPENING}
							</p>
							<p className="m-0 mt-2.5 max-w-[400px] text-pretty text-[13px] leading-[1.5] text-[rgba(232,236,244,0.46)]">
								{AGENT_TOOLS}
							</p>
						</div>
						<CopyPromptButton className="w-full shrink-0 sm:w-auto" />
					</div>
					<ol
						className={`m-0 grid list-none border-t p-0 px-5 sm:grid-cols-3 sm:px-7 ${RULE}`}
					>
						{AGENT_STEPS.map((step, i) => (
							<li
								key={step}
								className={`flex items-baseline gap-3 border-t py-3 text-[14px] leading-[1.45] text-[rgba(232,236,244,0.78)] first:border-t-0 sm:border-l sm:border-t-0 sm:py-4 sm:pl-5 sm:pr-3 sm:first:border-l-0 sm:first:pl-0 ${RULE}`}
							>
								<span
									aria-hidden="true"
									className={`${MONO} text-[12.5px] text-[rgba(232,236,244,0.4)]`}
								>
									{i + 1}
								</span>
								<span className="text-pretty">{step}</span>
							</li>
						))}
					</ol>
					<details className={`group border-t ${RULE}`}>
						<summary className="flex cursor-pointer list-none items-center justify-between gap-6 px-5 py-3.5 text-[14px] text-[rgba(232,236,244,0.6)] transition-colors duration-200 hover:text-[#E8ECF4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[rgba(232,236,244,0.7)] group-open:text-[#E8ECF4] sm:px-7 [&::-webkit-details-marker]:hidden">
							Read the prompt first
							<span
								aria-hidden="true"
								className="relative grid size-4 shrink-0 place-items-center text-[rgba(232,236,244,0.5)] transition-colors duration-200 group-hover:text-[#E8ECF4]"
							>
								<span className="absolute h-px w-[11px] bg-current" />
								<span className="absolute h-[11px] w-px bg-current transition-transform duration-200 group-open:scale-y-0" />
							</span>
						</summary>
						<pre
							className={`${MONO} m-0 max-h-[440px] overflow-y-auto whitespace-pre-wrap break-words border-t px-5 py-5 text-[12.5px] leading-[1.7] text-[rgba(232,236,244,0.72)] sm:px-7 ${RULE}`}
						>
							{CAP_INFRA_AGENT_PROMPT}
						</pre>
					</details>
					<div className={`border-t px-5 py-4 sm:px-7 ${RULE}`}>
						<p className="m-0 text-[13px] leading-[1.5] text-[rgba(232,236,244,0.46)]">
							Or link your agent to this page. The prompt is on it.
						</p>
						<div className="mt-1 flex items-center justify-between gap-3">
							<p
								className={`${MONO} m-0 min-w-0 text-pretty text-[13px] leading-[1.6] text-[rgba(232,236,244,0.86)]`}
							>
								{CAP_INFRA_POINTER_PROMPT}
							</p>
							<CopyPointerButton className="-mr-2" />
						</div>
					</div>
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-x-5 gap-y-3 self-start lg:col-start-1 lg:row-start-2">
				<Link href={LINKS.start} className={BTN_GHOST}>
					Start building
				</Link>
				<Link
					href={LINKS.agentDocs}
					className={`${TEXT_LINK} text-[14px] text-[rgba(232,236,244,0.6)] hover:text-[#E8ECF4]`}
				>
					Agent docs
				</Link>
			</div>
		</div>
	</Section>
);
