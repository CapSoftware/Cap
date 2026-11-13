import clsx from "clsx";
import Link from "next/link";
import { CAP_INFRA_AGENT_PROMPT } from "@/data/infra-agent-prompt";
import { CopyTextButton } from "./copy";
import { MONO, TEXT_LINK } from "./ui";

const [OPENING = ""] = CAP_INFRA_AGENT_PROMPT.split("\n");

export function AgentSetup({ compact = false }: { compact?: boolean }) {
	return (
		<div>
			{!compact && (
				<p
					className={clsx(
						MONO,
						"m-0 border-b border-[rgba(222,230,246,0.07)] py-3.5 text-pretty text-[13px] leading-[1.6] text-[rgba(232,236,244,0.86)]",
					)}
				>
					{OPENING}
				</p>
			)}
			<p
				className={clsx(
					"m-0 max-w-[520px] text-pretty text-[13.5px] leading-[1.6] text-[rgba(232,236,244,0.58)]",
					!compact && "mt-3",
				)}
			>
				One prompt for Claude Code, Codex or Cursor. Put the app's secret key in
				your project's environment file, and your agent reads the API reference
				and wires up uploads and playback.
			</p>
			<div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
				<CopyTextButton
					value={CAP_INFRA_AGENT_PROMPT}
					label="Copy agent prompt"
					variant={compact ? "ghost" : "primary"}
				/>
				<Link
					href="/docs/api/rest-api"
					className={clsx(
						TEXT_LINK,
						"text-[13px] text-[rgba(232,236,244,0.58)]",
					)}
				>
					API reference
				</Link>
			</div>
		</div>
	);
}
