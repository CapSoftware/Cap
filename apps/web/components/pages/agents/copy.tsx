"use client";

import { classNames } from "@cap/utils/helpers";
import { Check, Copy } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { MONO } from "@/components/pages/HomeTwo/theme";
import { Tokens } from "./tokens";

const COPIED_MS = 1800;

export const writeClipboard = async (text: string) => {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.select();
		let copied = false;
		try {
			copied = document.execCommand("copy");
		} catch {
			copied = false;
		}
		area.remove();
		return copied;
	}
};

export const useCopy = () => {
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (timer.current) window.clearTimeout(timer.current);
		},
		[],
	);

	const copy = useCallback(async (text: string) => {
		const ok = await writeClipboard(text);
		setCopied(ok);
		if (timer.current) window.clearTimeout(timer.current);
		if (ok)
			timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
		return ok;
	}, []);

	return { copied, copy };
};

export const CopyIconButton = ({
	text,
	label,
	dark,
	onCopy,
	className,
}: {
	text: string;
	label: string;
	dark?: boolean;
	onCopy?: () => void;
	className?: string;
}) => {
	const { copied, copy } = useCopy();
	return (
		<button
			type="button"
			aria-label={copied ? `${label} copied` : `Copy ${label}`}
			onClick={() => {
				onCopy?.();
				void copy(text);
			}}
			className={classNames(
				"grid size-8 shrink-0 place-items-center rounded-[8px] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2",
				dark
					? "text-[rgba(255,255,255,0.55)] hover:bg-white/10 hover:text-white focus-visible:ring-white"
					: "text-[rgba(17,17,17,0.5)] hover:bg-[#E7EDF3] hover:text-[#111111] focus-visible:ring-[#111111]",
				className,
			)}
		>
			<span className="relative grid size-4 place-items-center">
				<Copy
					className={classNames(
						"absolute size-4 transition-[opacity,transform] duration-200",
						copied ? "scale-50 opacity-0" : "scale-100 opacity-100",
					)}
					strokeWidth={2}
				/>
				<Check
					className={classNames(
						"absolute size-4 transition-[opacity,transform] duration-200",
						copied ? "scale-100 opacity-100" : "scale-50 opacity-0",
						dark ? "text-[#8FDCBB]" : "text-[#1B6E45]",
					)}
					strokeWidth={2.5}
				/>
			</span>
			<span aria-live="polite" className="sr-only">
				{copied ? "Copied" : ""}
			</span>
		</button>
	);
};

export const CopyLabelButton = ({
	text,
	children,
	copiedLabel = "Copied",
	onCopy,
	className,
}: {
	text: string;
	children: ReactNode;
	copiedLabel?: string;
	onCopy?: () => void;
	className: string;
}) => {
	const { copied, copy } = useCopy();
	return (
		<button
			type="button"
			onClick={() => {
				onCopy?.();
				void copy(text);
			}}
			className={classNames(className, "gap-2.5")}
		>
			<span className="relative grid size-[18px] place-items-center">
				<Copy
					className={classNames(
						"absolute size-[17px] transition-[opacity,transform] duration-200",
						copied ? "scale-50 opacity-0" : "scale-100 opacity-100",
					)}
					strokeWidth={2}
				/>
				<Check
					className={classNames(
						"absolute size-[18px] transition-[opacity,transform] duration-200",
						copied ? "scale-100 opacity-100" : "scale-50 opacity-0",
					)}
					strokeWidth={2.5}
				/>
			</span>
			<span className="relative">
				<span
					className={classNames(
						"block transition-opacity duration-200",
						copied ? "opacity-0" : "opacity-100",
					)}
				>
					{children}
				</span>
				<span
					aria-hidden={!copied}
					className={classNames(
						"absolute inset-0 grid place-items-center whitespace-nowrap transition-opacity duration-200",
						copied ? "opacity-100" : "opacity-0",
					)}
				>
					{copiedLabel}
				</span>
			</span>
			<span aria-live="polite" className="sr-only">
				{copied ? copiedLabel : ""}
			</span>
		</button>
	);
};

export const Snippet = ({
	lines,
	label,
	prompt = true,
	onCopy,
	className,
}: {
	lines: readonly string[];
	label: string;
	prompt?: boolean;
	onCopy?: () => void;
	className?: string;
}) => (
	<div
		className={classNames(
			"group/snippet relative rounded-[12px] bg-[#111111] text-[#F8FAFC] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]",
			className,
		)}
	>
		<pre
			className={classNames(
				MONO,
				"m-0 overflow-x-auto px-4 py-3.5 pr-12 text-[12.5px] leading-[1.7]",
			)}
		>
			{lines.map((line, i) => (
				<span
					key={`${i}-${line}`}
					className="block whitespace-pre-wrap break-words"
				>
					{prompt ? (
						<span className="select-none text-[rgba(255,255,255,0.38)]">
							${" "}
						</span>
					) : null}
					{prompt ? <Tokens text={line} /> : line}
				</span>
			))}
		</pre>
		<CopyIconButton
			text={lines.join("\n")}
			label={label}
			dark
			onCopy={onCopy}
			className="absolute right-2 top-2"
		/>
	</div>
);
