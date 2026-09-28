"use client";

import clsx from "clsx";

/**
 * The editor's layout, drawn by the page while the editor frame loads: the
 * share page's video morphs into the player here, then the editor fades in
 * over it.
 */
export function EditorEntryFrame({ frame }: { frame: string | null }) {
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 flex flex-col gap-2 pb-2"
		>
			<div className="h-[52px] shrink-0" />
			<div className="flex min-h-0 flex-1 gap-2 px-2">
				<div className="flex min-w-0 flex-1 flex-col rounded-xl bg-white/60 dark:bg-white/[0.04]">
					<div className="h-11 shrink-0" />
					<div className="flex min-h-0 flex-1 items-center justify-center p-4 [container-type:size]">
						<div
							className={clsx(
								"aspect-video w-[min(100cqw,100cqh*16/9)] overflow-hidden rounded-md",
								frame ? "bg-black" : "bg-black/[0.05] dark:bg-white/[0.05]",
							)}
							style={{ viewTransitionName: "cap-edit-video" }}
						>
							{frame && (
								<img src={frame} alt="" className="size-full object-contain" />
							)}
						</div>
					</div>
					<div className="h-12 shrink-0" />
				</div>
				<div className="w-[416px] shrink-0 rounded-xl bg-white/60 dark:bg-white/[0.04] max-[900px]:hidden" />
			</div>
			<div className="mx-2 h-12 shrink-0 rounded-xl bg-white/60 dark:bg-white/[0.04]" />
			<div className="mx-2 h-[min(260px,32%)] shrink-0 rounded-xl bg-white/60 dark:bg-white/[0.04]" />
		</div>
	);
}
