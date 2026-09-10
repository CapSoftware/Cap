"use client";

import Link from "next/link";
import { trackEvent } from "@/app/utils/analytics";
import { Eyebrow } from "@/components/pages/HomeTwo/Eyebrow";
import {
	BODY_TEXT,
	BTN_PRIMARY,
	BTN_SECONDARY,
	H_HERO,
	MODE_THEME,
	MONO,
} from "@/components/pages/HomeTwo/theme";
import { CAP_AGENT_PROMPT } from "@/data/agent-prompt";
import { POINTER_URL } from "./content";
import { CopyIconButton, CopyLabelButton } from "./copy";

export const FinalCta = () => (
	<section className="px-5 pb-24 pt-20 lg:pb-28 lg:pt-28">
		<div className="mx-auto flex max-w-[900px] flex-col items-center text-center">
			<Eyebrow accent={MODE_THEME.share.accent}>Get started</Eyebrow>
			<h2
				className={`${H_HERO} mt-6 text-balance text-[clamp(44px,6.4vw,78px)]`}
			>
				Point your agent at Cap.
			</h2>
			<p
				className={`${BODY_TEXT} mt-7 max-w-[560px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[18px]`}
			>
				One paste and your agent has an open source screen recorder it can run
				end to end: record, share, and manage everything in Cap on Mac, Windows,
				and Linux.
			</p>
			<div className="mt-9 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
				<CopyLabelButton
					text={CAP_AGENT_PROMPT}
					copiedLabel="Prompt copied"
					onCopy={() =>
						trackEvent("agents_prompt_copied", {
							source_page: "agents_final_cta",
							cta_location: "primary",
							variant: "full",
						})
					}
					className={BTN_PRIMARY}
				>
					Copy the setup prompt
				</CopyLabelButton>
				<Link href="/docs/agents" className={BTN_SECONDARY}>
					Read the agent docs
				</Link>
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
								source_page: "agents_final_cta",
								cta_location: "pointer",
								variant: "url",
							})
						}
						className="size-7 rounded-full"
					/>
				</span>
			</div>
		</div>
	</section>
);
