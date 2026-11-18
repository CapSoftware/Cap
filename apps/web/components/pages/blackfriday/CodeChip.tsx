"use client";

import { useState } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { CODE } from "./content";

export function CodeChip({ location }: { location: string }) {
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(CODE);
			setCopied(true);
			trackEvent("black_friday_code_copied", { cta_location: location });
			window.setTimeout(() => setCopied(false), 1600);
		} catch {
			setCopied(false);
		}
	};

	return (
		<button
			type="button"
			onClick={copy}
			title="Copy the code"
			className="rounded-[4px] font-medium text-[#F5F1EA] underline decoration-[rgba(245,241,234,0.35)] decoration-dotted underline-offset-4 transition-colors hover:decoration-[#F5F1EA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5F1EA]"
		>
			<span aria-live="polite">{copied ? "Copied" : CODE}</span>
		</button>
	);
}
