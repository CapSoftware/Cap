"use client";

import clsx from "clsx";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export function CopyButton({
	value,
	label = "Copy",
	className,
}: {
	value: string;
	label?: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);
	const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (timeout.current) clearTimeout(timeout.current);
		},
		[],
	);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(value);
		} catch {
			toast.error("Could not copy to the clipboard");
			return;
		}
		setCopied(true);
		if (timeout.current) clearTimeout(timeout.current);
		timeout.current = setTimeout(() => setCopied(false), 2000);
	};

	return (
		<button
			type="button"
			onClick={handleCopy}
			aria-label={label}
			title={label}
			className={clsx(
				"inline-flex justify-center items-center rounded-md transition-colors size-7 shrink-0 text-gray-10 hover:bg-gray-4 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-8",
				className,
			)}
		>
			{copied ? <Check size={14} /> : <Copy size={14} />}
		</button>
	);
}
