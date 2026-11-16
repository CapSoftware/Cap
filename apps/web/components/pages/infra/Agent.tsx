import Link from "next/link";
import { CAP_INFRA_POINTER_PROMPT } from "@/data/infra-agent-prompt";
import { CopyPointerButton } from "./AgentCopy";
import { AgentPrompt } from "./AgentPrompt";
import { AGENT_SUMMARY, ANCHORS, LINKS, PREVIEW_NOTE } from "./content";
import { Section, SectionHeading, StartLink } from "./shared";
import { BTN_GHOST, MONO, TEXT_LINK } from "./theme";

export const Agent = () => (
	<Section id={ANCHORS.agents} className="pt-20 lg:pt-28">
		<div className="grid gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-y-8">
			<SectionHeading title="Bring your agent.">
				<p>{AGENT_SUMMARY}</p>
				{PREVIEW_NOTE ? <p className="pt-3">{PREVIEW_NOTE}</p> : null}
			</SectionHeading>
			<div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
				<AgentPrompt />
				<div className="mt-9 flex items-end justify-between gap-4 border-t border-[rgba(222,230,246,0.08)] pt-5">
					<div className="min-w-0">
						<p className="m-0 text-[13px] leading-[1.5] text-[rgba(232,236,244,0.46)]">
							Or link your agent to this page. The prompt is on it.
						</p>
						<p
							className={`${MONO} m-0 mt-1.5 text-pretty text-[13px] leading-[1.6] text-[rgba(232,236,244,0.86)]`}
						>
							{CAP_INFRA_POINTER_PROMPT}
						</p>
					</div>
					<CopyPointerButton className="-mb-1.5 -mr-2" />
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-x-5 gap-y-3 self-start lg:col-start-1 lg:row-start-2">
				<StartLink className={BTN_GHOST} />
				<Link
					href={LINKS.reference}
					className={`${TEXT_LINK} text-[14px] text-[rgba(232,236,244,0.6)] hover:text-[#E8ECF4]`}
				>
					API reference
				</Link>
			</div>
		</div>
	</Section>
);
