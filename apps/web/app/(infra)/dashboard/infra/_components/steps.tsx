import clsx from "clsx";
import type { ReactNode } from "react";
import { LIT } from "./ui";

export function Steps({
	reached,
	total,
	children,
}: {
	reached: number;
	total: number;
	children: ReactNode;
}) {
	const share = total > 1 ? Math.min(reached, total) / total : 0;
	return (
		<ol className="relative m-0 flex list-none flex-col gap-9 p-0 pl-9">
			<span
				aria-hidden="true"
				className="absolute bottom-1 left-[5px] top-1 w-px bg-[rgba(222,230,246,0.1)]"
			/>
			<span
				aria-hidden="true"
				style={{ height: `calc((100% - 8px) * ${share})` }}
				className={clsx(
					"absolute left-[4.5px] top-1 w-[2px] rounded-full transition-[height] duration-[1200ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
					share > 0 ? LIT : "bg-transparent",
				)}
			/>
			{children}
		</ol>
	);
}

export function Step({
	title,
	state,
	children,
}: {
	title: string;
	state: "done" | "current" | "next";
	children?: ReactNode;
}) {
	return (
		<li className="relative min-w-0">
			<span
				aria-hidden="true"
				className={clsx(
					"absolute -left-9 top-[5px] size-[11px] rounded-full transition-colors duration-700",
					state === "next"
						? "bg-[#050506] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.22)]"
						: "bg-white shadow-[0_0_0_3px_#050506,0_0_10px_2px_rgba(214,228,255,0.55)]",
				)}
			/>
			<h3
				className={clsx(
					"m-0 text-[15px] font-medium leading-[1.4] tracking-[-0.01em] transition-colors duration-700",
					state === "next" ? "text-[rgba(232,236,244,0.5)]" : "text-[#E8ECF4]",
				)}
			>
				{title}
				{state === "done" && <span className="sr-only"> (done)</span>}
			</h3>
			{children && <div className="mt-3 min-w-0">{children}</div>}
		</li>
	);
}

export function StepNote({ children }: { children: ReactNode }) {
	return (
		<p className="m-0 max-w-[520px] text-pretty text-[13.5px] leading-[1.6] text-[rgba(232,236,244,0.5)]">
			{children}
		</p>
	);
}
