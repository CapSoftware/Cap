"use client";

import { Check, Copy } from "lucide-react";
import {
	type ComponentPropsWithoutRef,
	useEffect,
	useRef,
	useState,
} from "react";

export function DocsCodeBlock(props: ComponentPropsWithoutRef<"pre">) {
	const { className, children, ...rest } = props;
	const preRef = useRef<HTMLPreElement>(null);
	const [copied, setCopied] = useState(false);
	const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (resetTimer.current) clearTimeout(resetTimer.current);
		};
	}, []);

	const copy = () => {
		const text = preRef.current?.innerText ?? "";
		navigator.clipboard.writeText(text.trimEnd()).then(
			() => {
				setCopied(true);
				if (resetTimer.current) clearTimeout(resetTimer.current);
				resetTimer.current = setTimeout(() => setCopied(false), 2000);
			},
			() => undefined,
		);
	};

	return (
		<div className="group relative">
			<pre
				{...rest}
				ref={preRef}
				className={`my-0 max-h-[560px] overflow-auto rounded-xl !bg-[#0E1116] px-4 py-3.5 text-[13px] leading-[1.7] [scrollbar-width:thin] [&_code]:bg-transparent [&_code]:p-0 ${
					className ?? ""
				}`}
			>
				{children}
			</pre>
			<button
				type="button"
				onClick={copy}
				aria-label={copied ? "Copied" : "Copy code"}
				className="absolute right-2.5 top-2.5 flex size-7 items-center justify-center rounded-md border border-white/10 bg-white/[0.06] text-white/60 opacity-0 backdrop-blur transition-all hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
			>
				{copied ? (
					<Check className="size-3.5 text-emerald-400" />
				) : (
					<Copy className="size-3.5" />
				)}
			</button>
		</div>
	);
}
