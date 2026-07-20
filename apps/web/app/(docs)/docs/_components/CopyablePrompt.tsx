"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export const CAP_AGENT_PROMPT = `Set up Cap as my complete video assistant, then use it to help with the task at the end.

Read these pages and treat them as operating instructions:
- https://cap.so/docs/agents
- https://cap.so/docs/agents/setup
- https://cap.so/docs/agents/workflows
- https://cap.so/docs/agents/safety

Do not rely on remembered Cap commands. Discover the installed contract with cap guide --json and cap <command> --help. Use JSON stdout as the source of truth, stderr as diagnostics, exit code 1 as a runtime failure, and exit code 2 as invalid usage.

Set up Cap:
1. Identify my operating system and the agent you are running in. Select only the current agent; never install into every detected agent.
2. Run cap version --json. If the cap command is missing, show me the exact platform install command and what it changes, then wait for my confirmation before running it:
   - macOS or Linux: curl -fsSL https://cap.so/install-cli.sh | sh
   - Windows PowerShell: irm https://cap.so/install-cli.ps1 | iex
   Open a new shell if PATH changes, then verify cap version --json and cap guide --json.
3. Run cap auth status --json. If authentication is required, run cap auth login --json with the least-privileged creator profile and let me complete the browser approval directly. Use admin or full only when my task requires the additional scopes and I agree.
4. If you are Codex, Claude Code, or Cursor, preview the complete integration with:
   cap agents install --target <codex|claude|cursor> --component all --dry-run --json
   Show me the exact skill and MCP configuration paths and values. After I approve, apply the same command with --yes instead of --dry-run. This must install the full Cap skill and the local cap mcp serve integration without replacing unrelated agent configuration. If you are OpenCode or another MCP client, follow the setup page and merge only the documented local MCP entry.
5. Tell me if the agent must restart to load the new skill or MCP server. Continue the current task through the CLI when a restart is not practical.
6. Verify the setup with cap version --json, cap guide --json, cap auth status --json, and cap caps list --limit 1 --json. If MCP is loaded, list its Cap tools and confirm that passwords and storage credentials are not accepted as MCP inputs.

Use Cap as an ongoing helper. Learn the complete surface from the installed guide and skill, including:
- Recording: check cap doctor --json, discover inputs with cap targets --json, ask before capture, use the detached cap record start and cap record stop lifecycle, require recordingMetaExists: true, validate the .cap project, export it, ask again before upload, and return the verified share link.
- Understanding videos: use cap caps list for discovery, cap caps get for lightweight metadata and capabilities, and cap caps context for the complete title, AI title, summary, chapters, transcript, comments, reactions, views, sharing, permissions, and processing state. Cite useful transcript timestamps.
- Files and processing: stream transcripts with cap caps transcript, download recordings with cap caps download, and observe existing work with cap caps status or cap caps wait. Never claim that a read or wait started transcription or AI work.
- Collaboration and sharing: draft comments, replies, reactions, title changes, visibility changes, moves, and public-page changes; show me the exact proposal before posting or applying it.
- Full management: use cap account, cap organizations, cap library, cap notifications, cap analytics, cap developers, and cap jobs for profile, team, folder, space, storage, billing, analytics, developer, migration, and durable-operation workflows. Discover flags with --help instead of guessing.
- Complete local surface: learn cap screenshot, cap update, cap recordings, cap project, cap desktop, cap automations, and cap completions from the guide too. Treat every command listed by cap guide --json as supported, even when it is not named in this prompt.
- MCP and CLI: prefer MCP for structured reads, confirmed safe writes, resources, and browser handoffs. Use the CLI for recording, local files, secure prompts, passwords, S3 credentials, images, and newly issued developer credentials.

Operating rules:
- Start with read-only discovery. Before any mutation, upload, paid processing, recording, comment or reaction, sharing or visibility change, deletion, organization, billing, storage, developer, or credential action, show me the exact proposed action and wait for my explicit confirmation. Pass --yes or confirmed=true only after I confirm.
- Never ask me to paste passwords, CAP_AGENT_TOKEN, API keys, S3 credentials, or newly issued developer secrets into chat or MCP. Ask me to run the exact secure Cap command in my terminal. For a password-protected Cap, ask me to run cap caps unlock <id-or-url>.
- Preserve returned Cap, organization, folder, space, member, comment, and operation IDs. Never infer IDs from names or invent results.
- Wait for asynchronous operations with cap jobs wait and verify the affected resource before reporting success. Clearly separate what you verified from reasonable interpretation and anything you could not verify.
- Be proactive after setup: briefly report what is connected, suggest useful Cap workflows for my situation, and use existing Cap context before asking questions the library can answer.

My task: Set up Cap completely, tell me what you can now help me do, and ask which Cap task I want to start with.`;

const setupBenefits = [
	"Installs the Cap CLI",
	"Adds the full Cap skill",
	"Connects local MCP",
	"Verifies access and capabilities",
] as const;

export async function copyAgentPrompt(textArea: HTMLTextAreaElement) {
	textArea.focus();
	textArea.select();
	textArea.setSelectionRange(0, CAP_AGENT_PROMPT.length);
	const copiedWithSelection =
		typeof document.execCommand === "function" && document.execCommand("copy");
	if (copiedWithSelection) return true;

	let clipboardTimeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const copyAttempt = navigator.clipboard.writeText(CAP_AGENT_PROMPT).then(
			() => true,
			() => false,
		);
		const timeoutAttempt = new Promise<boolean>((resolve) => {
			clipboardTimeout = setTimeout(() => resolve(false), 1_000);
		});
		return await Promise.race([copyAttempt, timeoutAttempt]);
	} catch {
		return false;
	} finally {
		if (clipboardTimeout) clearTimeout(clipboardTimeout);
	}
}

export function CopyablePrompt() {
	const [copyState, setCopyState] = useState<"idle" | "copied" | "selected">(
		"idle",
	);
	const [isExpanded, setIsExpanded] = useState(false);
	const promptTextArea = useRef<HTMLTextAreaElement>(null);
	const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (resetTimer.current) clearTimeout(resetTimer.current);
		};
	}, []);

	const copyPrompt = async () => {
		const textArea = promptTextArea.current;
		if (!textArea) return;
		setCopyState("selected");
		const copiedSuccessfully = await copyAgentPrompt(textArea);

		if (copiedSuccessfully) {
			setCopyState("copied");
			if (resetTimer.current) clearTimeout(resetTimer.current);
			resetTimer.current = setTimeout(() => setCopyState("idle"), 2_000);
		} else {
			setCopyState("selected");
		}
	};

	const copyLabel =
		copyState === "copied"
			? "Copied"
			: copyState === "selected"
				? "Prompt Selected"
				: "Copy Agent Setup Prompt";
	const copyStatus =
		copyState === "copied"
			? "Copied. Paste it into your agent to begin."
			: copyState === "selected"
				? "The prompt is selected. Press ⌘ C or Ctrl C to copy it."
				: "";

	return (
		<section className="not-prose my-8 overflow-hidden rounded-2xl border border-gray-4 bg-gray-1">
			<div className="p-6 sm:p-8">
				<p className="mb-2 text-[13px] font-medium leading-5 text-blue-11">
					One prompt setup
				</p>
				<h2 className="max-w-2xl text-balance text-xl font-medium tracking-[-0.01em] text-gray-12 sm:text-2xl">
					Make Cap Your Agent’s Video Assistant
				</h2>
				<p className="mt-2.5 max-w-2xl text-pretty text-[15px] leading-6 text-gray-11">
					Copy one prompt into Codex, Claude Code, Cursor, OpenCode, or any
					shell-capable agent. It installs Cap, connects the full skill and MCP,
					authenticates safely, and teaches your agent to record, share, search,
					transcribe, summarize, and manage Cap for you.
				</p>

				<ul className="mt-5 flex flex-wrap gap-2">
					{setupBenefits.map((benefit) => (
						<li
							key={benefit}
							className="flex items-center gap-1.5 rounded-full border border-gray-4 bg-gray-2 py-1.5 pl-2.5 pr-3 text-[13px] leading-4 text-gray-11"
						>
							<Check
								aria-hidden="true"
								className="size-3.5 shrink-0 text-blue-9"
							/>
							<span>{benefit}</span>
						</li>
					))}
				</ul>

				<div className="mt-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
					<button
						type="button"
						onClick={() => void copyPrompt()}
						className="inline-flex h-10 w-full shrink-0 touch-manipulation items-center justify-center gap-2 whitespace-nowrap rounded-full bg-gray-12 px-5 text-sm font-medium text-gray-1 transition-colors hover:bg-gray-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 sm:w-auto"
						aria-label={
							copyState === "copied"
								? "Cap agent setup prompt copied"
								: copyState === "selected"
									? "Cap agent setup prompt selected for manual copy"
									: "Copy Cap agent setup prompt"
						}
					>
						{copyState === "copied" ? (
							<Check aria-hidden="true" className="size-4" />
						) : (
							<Copy aria-hidden="true" className="size-4" />
						)}
						<span>{copyLabel}</span>
					</button>
					<p aria-live="polite" className="text-[13px] leading-5 text-gray-10">
						{copyStatus}
					</p>
				</div>
			</div>

			<textarea
				ref={promptTextArea}
				value={CAP_AGENT_PROMPT}
				readOnly
				aria-hidden="true"
				tabIndex={-1}
				className="sr-only"
			/>

			<div className="border-t border-gray-4 bg-[#0B0D12]">
				<div className="flex items-center justify-between px-4 py-2.5">
					<div className="flex items-center gap-3">
						<div aria-hidden="true" className="flex items-center gap-1.5">
							<span className="size-2.5 rounded-full bg-[#FF5F57]" />
							<span className="size-2.5 rounded-full bg-[#FEBC2E]" />
							<span className="size-2.5 rounded-full bg-[#28C840]" />
						</div>
						<span className="font-mono text-xs text-white/40">
							cap agent setup
						</span>
					</div>
					<button
						type="button"
						onClick={() => void copyPrompt()}
						aria-label={
							copyState === "copied" ? "Prompt copied" : "Copy prompt"
						}
						className="flex size-7 items-center justify-center rounded-md border border-white/10 bg-white/[0.06] text-white/60 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
					>
						{copyState === "copied" ? (
							<Check aria-hidden="true" className="size-3.5 text-emerald-400" />
						) : (
							<Copy aria-hidden="true" className="size-3.5" />
						)}
					</button>
				</div>
				<div className="relative">
					<pre
						className={`m-0 whitespace-pre-wrap px-4 pb-5 font-mono text-xs leading-5 text-[#C9CED6] selection:bg-[#2E6BE573] sm:px-5 sm:text-[12.5px] sm:leading-[1.7] ${
							isExpanded ? "" : "max-h-52 overflow-hidden"
						}`}
					>
						{CAP_AGENT_PROMPT}
					</pre>
					{!isExpanded && (
						<div className="absolute inset-x-0 bottom-0 flex h-28 items-end justify-center bg-gradient-to-t from-[#0B0D12] via-[#0B0D12]/85 to-transparent pb-4">
							<button
								type="button"
								onClick={() => setIsExpanded(true)}
								className="rounded-full border border-white/15 bg-white/[0.08] px-3.5 py-1.5 text-xs font-medium text-white/80 transition-colors hover:bg-white/15 hover:text-white"
							>
								Show full prompt
							</button>
						</div>
					)}
				</div>
				{isExpanded && (
					<div className="flex justify-center pb-4">
						<button
							type="button"
							onClick={() => setIsExpanded(false)}
							className="rounded-full border border-white/15 bg-white/[0.08] px-3.5 py-1.5 text-xs font-medium text-white/80 transition-colors hover:bg-white/15 hover:text-white"
						>
							Show less
						</button>
					</div>
				)}
			</div>
		</section>
	);
}
