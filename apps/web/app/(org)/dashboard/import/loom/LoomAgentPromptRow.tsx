"use client";

import { Button } from "@cap/ui";
import { faTerminal } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { buildLoomAgentMigrationPrompt } from "@/lib/loom-agent-prompt";

export function LoomAgentPromptRow({
	organizationId,
	organizationName,
	userEmail,
}: {
	organizationId: string;
	organizationName: string;
	userEmail: string;
}) {
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);
	const [origin, setOrigin] = useState("");
	const promptId = useId();
	const textAreaRef = useRef<HTMLTextAreaElement>(null);
	const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		setOrigin(window.location.origin);
		return () => {
			if (resetTimer.current) clearTimeout(resetTimer.current);
		};
	}, []);

	const prompt = useMemo(
		() =>
			buildLoomAgentMigrationPrompt({
				organizationId,
				organizationName,
				userEmail,
				origin,
			}),
		[organizationId, organizationName, userEmail, origin],
	);

	const copyPrompt = async () => {
		try {
			await navigator.clipboard.writeText(prompt);
			setCopied(true);
			if (resetTimer.current) clearTimeout(resetTimer.current);
			resetTimer.current = setTimeout(() => setCopied(false), 2000);
			toast.success("Prompt copied. Paste it into your agent.");
		} catch {
			setExpanded(true);
			requestAnimationFrame(() => textAreaRef.current?.select());
			toast.error("Couldn't copy automatically. The prompt is selected.");
		}
	};

	return (
		<div className="flex flex-col gap-4 p-5 rounded-xl border bg-gray-2 border-gray-3">
			<div className="flex flex-col gap-4 justify-between sm:flex-row sm:items-center">
				<div className="flex gap-4 items-start sm:items-center">
					<div className="flex flex-shrink-0 justify-center items-center rounded-lg size-10 bg-gray-3 text-gray-11">
						<FontAwesomeIcon className="size-4" icon={faTerminal} />
					</div>
					<div className="flex flex-col gap-1.5">
						<p className="text-sm font-medium text-gray-12">
							Hand it to your agent
						</p>
						<p className="text-xs text-gray-10">
							Copy a prompt with everything Claude Code, Codex or Cursor needs
							to run the whole migration with the Cap CLI.
						</p>
					</div>
				</div>
				<div className="flex flex-shrink-0 gap-2">
					<Button
						type="button"
						variant="gray"
						size="sm"
						aria-expanded={expanded}
						aria-controls={promptId}
						onClick={() => setExpanded((value) => !value)}
					>
						{expanded ? "Hide prompt" : "View prompt"}
					</Button>
					<Button
						type="button"
						variant="white"
						size="sm"
						disabled={!origin}
						onClick={copyPrompt}
					>
						{copied ? "Copied" : "Copy prompt"}
					</Button>
				</div>
			</div>

			{expanded && (
				<textarea
					id={promptId}
					ref={textAreaRef}
					readOnly
					aria-label="Agent migration prompt"
					value={prompt}
					className="w-full h-72 px-4 py-3 font-mono text-xs rounded-xl border resize-y text-gray-12 bg-gray-1 border-gray-4 outline-0 focus:border-gray-5"
				/>
			)}
		</div>
	);
}
