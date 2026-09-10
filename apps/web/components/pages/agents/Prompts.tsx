"use client";

import { classNames } from "@cap/utils/helpers";
import { trackEvent } from "@/app/utils/analytics";
import { Eyebrow } from "@/components/pages/HomeTwo/Eyebrow";
import {
	BAND,
	BODY_TEXT,
	grainBg,
	H_SECTION,
	MODE_THEME,
	MONO,
} from "@/components/pages/HomeTwo/theme";
import { examplePrompts } from "./content";
import { CopyLabelButton } from "./copy";

export const Prompts = () => (
	<section className="px-5 pb-20 lg:pb-28">
		<div className="mx-auto max-w-[1200px]">
			<div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
				<Eyebrow accent={MODE_THEME.share.accent}>Ask in plain English</Eyebrow>
				<h2
					className={`${H_SECTION} mt-6 text-balance text-[clamp(36px,4.6vw,56px)]`}
				>
					Prompts you can paste right now
				</h2>
				<p
					className={`${BODY_TEXT} mt-6 max-w-[600px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[17.5px]`}
				>
					Every one of these works after setup. Your agent reads first, shows
					you the plan, and waits for a yes before anything changes.
				</p>
			</div>

			<ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{examplePrompts.map((prompt) => {
					const theme = MODE_THEME[prompt.mode];
					return (
						<li
							key={prompt.text}
							className="flex flex-col justify-between rounded-[20px] p-6 transition-colors duration-200 hover:bg-[#E5EAF1]"
							style={grainBg(BAND)}
						>
							<div>
								<span
									className={classNames(
										MONO,
										"inline-flex items-center gap-2 text-[11px] uppercase leading-none tracking-[0.05em] text-[rgba(17,17,17,0.55)]",
									)}
								>
									<span
										aria-hidden="true"
										className="inline-block size-[7px]"
										style={{ background: theme.accent }}
									/>
									{prompt.category}
								</span>
								<p className="mt-5 text-[17px] font-normal leading-[1.4] tracking-[-0.015em] text-[#111111]">
									“{prompt.text}”
								</p>
							</div>
							<CopyLabelButton
								text={prompt.text}
								copiedLabel="Copied"
								onCopy={() =>
									trackEvent("agents_prompt_copied", {
										source_page: "agents_prompts",
										cta_location: "example",
										variant: prompt.category.toLowerCase(),
									})
								}
								className="mt-7 inline-flex h-9 items-center justify-center self-start rounded-full bg-white px-3.5 text-[13px] font-medium text-[#111111] shadow-[0_0_0_1px_rgba(17,17,17,0.08)] transition-colors duration-200 hover:bg-[#111111] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-2"
							>
								Copy prompt
							</CopyLabelButton>
						</li>
					);
				})}
			</ul>
		</div>
	</section>
);
