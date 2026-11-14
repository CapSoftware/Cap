"use client";

import clsx from "clsx";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, FOCUS, MONO } from "./ui";

function useCopy(value: string) {
	const [copied, setCopied] = useState(false);
	const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (timeout.current) clearTimeout(timeout.current);
		},
		[],
	);

	const copy = async () => {
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

	return { copied, copy };
}

const ICON_BUTTON = clsx(
	"inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] text-[rgba(232,236,244,0.46)] transition-colors duration-200 hover:bg-[rgba(222,230,246,0.07)] hover:text-[#E8ECF4]",
	FOCUS,
);

function Announce({ copied }: { copied: boolean }) {
	return <output className="sr-only">{copied ? "Copied" : ""}</output>;
}

export function CopyButton({
	value,
	label = "Copy",
	className,
}: {
	value: string;
	label?: string;
	className?: string;
}) {
	const { copied, copy } = useCopy(value);
	return (
		<span className="relative inline-flex shrink-0">
			<button
				type="button"
				onClick={copy}
				aria-label={label}
				title={copied ? undefined : label}
				className={clsx(ICON_BUTTON, copied && "text-white", className)}
			>
				{copied ? <Check size={14} /> : <Copy size={14} />}
			</button>
			{copied && (
				<span
					aria-hidden="true"
					className="pointer-events-none absolute bottom-full right-0 z-10 mb-1 whitespace-nowrap rounded-[6px] bg-[#191B1F] px-2 py-1 text-[12px] leading-none text-[#E8ECF4] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.14)] [font-family:var(--font-infra-sans),system-ui,sans-serif]"
				>
					Copied
				</span>
			)}
			<Announce copied={copied} />
		</span>
	);
}

export function CopyTextButton({
	value,
	label,
	variant = "ghost",
}: {
	value: string;
	label: string;
	variant?: "primary" | "ghost";
}) {
	const { copied, copy } = useCopy(value);
	return (
		<>
			<Button variant={variant} size="sm" onClick={copy}>
				{copied && <Check size={14} aria-hidden="true" />}
				{copied ? "Copied" : label}
			</Button>
			<Announce copied={copied} />
		</>
	);
}

export function KeyRow({
	label,
	value,
	note,
	sensitive = false,
	copyable = true,
}: {
	label: string;
	value: string;
	note?: string;
	sensitive?: boolean;
	copyable?: boolean;
}) {
	const [visible, setVisible] = useState(!sensitive);
	const shown = visible ? value : `${value.slice(0, 8)}${"•".repeat(24)}`;

	return (
		<div className="flex items-center gap-4 border-b border-[rgba(222,230,246,0.07)] py-3.5">
			<div className="w-[104px] shrink-0">
				<p className="m-0 text-[13.5px] leading-[1.3] text-[#E8ECF4]">
					{label}
				</p>
				{note && (
					<p className="m-0 mt-0.5 text-[12px] leading-[1.3] text-[rgba(232,236,244,0.4)]">
						{note}
					</p>
				)}
			</div>
			<code
				className={clsx(
					MONO,
					"min-w-0 flex-1 truncate text-[13px] text-[rgba(232,236,244,0.86)]",
				)}
			>
				{shown}
			</code>
			<div className="flex shrink-0 items-center gap-0.5">
				{sensitive && (
					<button
						type="button"
						onClick={() => setVisible((v) => !v)}
						aria-label={visible ? `Hide ${label}` : `Show ${label}`}
						className={ICON_BUTTON}
					>
						{visible ? <EyeOff size={14} /> : <Eye size={14} />}
					</button>
				)}
				{copyable && <CopyButton value={value} label={`Copy ${label}`} />}
			</div>
		</div>
	);
}

export function CodeBlock({
	code,
	label,
	className,
}: {
	code: string;
	label: string;
	className?: string;
}) {
	return (
		<div
			className={clsx(
				"relative rounded-[10px] bg-[rgba(222,230,246,0.035)] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.08)]",
				className,
			)}
		>
			<pre
				className={clsx(
					MONO,
					"m-0 overflow-x-auto py-4 pl-4 pr-12 text-[12.5px] leading-[1.7] text-[rgba(232,236,244,0.86)]",
				)}
			>
				{code}
			</pre>
			<span className="absolute right-2 top-2">
				<CopyButton
					value={code}
					label={`Copy ${label}`}
					className="bg-[#0C0D0F] shadow-[0_0_0_4px_#0C0D0F] hover:bg-[#191B1F]"
				/>
			</span>
		</div>
	);
}
