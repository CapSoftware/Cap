"use client";

import { classNames } from "@cap/utils/helpers";
import { useId, useState } from "react";
import { CAP_INFRA_AGENT_PROMPT } from "@/data/infra-agent-prompt";
import { CopyPromptButton } from "./AgentCopy";
import { AGENT_TOOLS } from "./content";
import styles from "./scene.module.css";
import { MONO } from "./theme";

const [OPENING = "", ...REST] = CAP_INFRA_AGENT_PROMPT.split("\n");

const REMAINDER = REST.join("\n").trim();

export const AgentPrompt = () => {
	const [open, setOpen] = useState(false);
	const bodyId = useId();

	return (
		<figure className="m-0">
			<figcaption className="flex flex-col gap-x-8 gap-y-5 sm:flex-row sm:items-end sm:justify-between">
				<p className="m-0 max-w-[400px] text-pretty text-[15px] leading-[1.5] text-[rgba(232,236,244,0.56)]">
					<span className="block leading-[inherit] text-[#E8ECF4]">
						Paste this into your agent
					</span>
					{AGENT_TOOLS}
				</p>
				<CopyPromptButton className="shrink-0 self-start sm:self-auto" />
			</figcaption>
			<div className="mt-6 border-t border-[rgba(222,230,246,0.08)] pt-6">
				<p
					className={`${MONO} m-0 text-pretty text-[15px] leading-[1.6] tracking-[-0.01em] text-white sm:text-[17px]`}
				>
					{OPENING}
					<span aria-hidden="true" className={styles.caret} />
				</p>
				<pre
					id={bodyId}
					className={classNames(
						MONO,
						"m-0 mt-4 whitespace-pre-wrap break-words text-[12.5px] leading-[1.7] text-[rgba(232,236,244,0.62)]",
						open ? "" : styles.promptFade,
					)}
				>
					{REMAINDER}
				</pre>
				<button
					type="button"
					aria-expanded={open}
					aria-controls={bodyId}
					onClick={() => setOpen((value) => !value)}
					className={classNames(
						"group inline-flex items-center gap-2.5 rounded-[6px] text-[13.5px] text-[rgba(232,236,244,0.6)] transition-colors duration-200 hover:text-[#E8ECF4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(232,236,244,0.7)] focus-visible:ring-offset-4 focus-visible:ring-offset-[#050506]",
						open ? "mt-5" : "mt-3",
					)}
				>
					<span
						aria-hidden="true"
						className="relative grid size-3 shrink-0 place-items-center"
					>
						<span className="absolute h-px w-[9px] bg-current" />
						<span
							className={classNames(
								"absolute h-[9px] w-px bg-current transition-transform duration-200",
								open ? "scale-y-0" : "",
							)}
						/>
					</span>
					{open ? "Hide the prompt" : "Read the full prompt"}
				</button>
			</div>
		</figure>
	);
};
