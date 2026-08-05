import clsx from "clsx";
import type { ReactNode } from "react";

/**
 * The frame every interactive in the timeline post sits in.
 *
 * Two things it has to do: break out of the 65ch prose column without ever
 * introducing a horizontal scrollbar (hence `92vw`, not `100vw`), and mark
 * itself `not-prose` so blog typography stops at its edge. Note that the demos
 * avoid `p`, `a` and `li` entirely — globals.css sizes those inside `.prose`
 * with `!important`, which `not-prose` cannot undo.
 */
export function DemoPanel({
	title,
	hint,
	action,
	caption,
	bodyClassName,
	children,
}: {
	/** Names the thing being demonstrated, e.g. "The timestamp list". */
	title: string;
	/** One line telling the reader what to do. */
	hint?: string;
	/** Header-right slot: reset buttons and the like. */
	action?: ReactNode;
	/** Runs under the panel, in the voice of the post. */
	caption?: ReactNode;
	bodyClassName?: string;
	children: ReactNode;
}) {
	return (
		<div className="not-prose relative left-1/2 my-10 w-[min(92vw,56rem)] -translate-x-1/2 sm:my-14">
			<div className="overflow-hidden rounded-2xl border border-gray-4 bg-white shadow-[0_10px_30px_rgba(18,22,31,0.05)]">
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-gray-4 bg-gray-2 px-4 py-3 sm:px-5">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<span className="inline-block size-1.5 shrink-0 rounded-full bg-blue-9" />
							<span className="text-[11px] font-medium uppercase tracking-[0.08em] text-gray-10">
								Interactive
							</span>
						</div>
						<div className="mt-0.5 truncate text-sm font-medium text-gray-12">
							{title}
						</div>
					</div>
					{action}
				</div>

				<div className={clsx("p-4 sm:p-6", bodyClassName)}>
					{hint && (
						<div className="mb-4 text-[13px] leading-relaxed text-gray-10">
							{hint}
						</div>
					)}
					{children}
				</div>
			</div>

			{caption && (
				<div className="mx-1 mt-3 text-[13px] leading-relaxed text-gray-10">
					{caption}
				</div>
			)}
		</div>
	);
}

/** Small neutral button, used for resets and mode switches inside demos. */
export function DemoButton({
	onClick,
	children,
	variant = "ghost",
	disabled,
	className,
	title,
}: {
	onClick: () => void;
	children: ReactNode;
	variant?: "ghost" | "solid";
	disabled?: boolean;
	className?: string;
	title?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			className={clsx(
				"inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9",
				variant === "solid"
					? "bg-gray-12 text-white hover:bg-gray-12/90"
					: "border border-gray-5 bg-white text-gray-12 hover:bg-gray-3",
				disabled && "cursor-not-allowed opacity-50",
				className,
			)}
		>
			{children}
		</button>
	);
}
