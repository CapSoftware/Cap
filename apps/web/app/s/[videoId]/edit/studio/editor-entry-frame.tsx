"use client";

import clsx from "clsx";

/**
 * CSS alone, so it shows while the page is still hydrating on a slow
 * connection.
 */
function EntryLoadingStatus() {
	return (
		<div className="absolute inset-0 flex items-center justify-center p-3">
			<style>
				{`@keyframes cap-entry-in{from{opacity:0;transform:translateY(4px) scale(.98)}to{opacity:1;transform:none}}
@keyframes cap-entry-slow{from{opacity:0;max-height:0;margin-top:-8px}to{opacity:1;max-height:4rem;margin-top:-2px}}
.cap-entry-status{opacity:0;animation:cap-entry-in 180ms cubic-bezier(.2,0,0,1) 250ms forwards}
.cap-entry-slow{opacity:0;max-height:0;margin-top:-8px;overflow:hidden;animation:cap-entry-slow 240ms ease-out 6s forwards}
@media (prefers-reduced-motion:reduce){.cap-entry-status{animation-duration:1ms}.cap-entry-slow{animation-duration:1ms}}`}
			</style>
			<output className="cap-entry-status flex max-w-[16.5rem] flex-col items-center gap-2 rounded-xl bg-[rgba(18,18,20,0.72)] px-4 pb-3 pt-3.5 text-center text-white shadow-[0_0_0_0.5px_rgba(255,255,255,0.14),0_10px_28px_-8px_rgba(0,0,0,0.5)] backdrop-blur-md">
				<span
					aria-hidden="true"
					className="size-6 shrink-0 animate-spin rounded-full border-[2.5px] border-white/20 border-t-white motion-reduce:animate-none"
				/>
				<span className="text-[13px] font-medium leading-4">
					Loading editor
				</span>
				<span className="cap-entry-slow text-[12px] leading-4 text-white/70">
					Taking longer than usual. The editor opens as soon as it has loaded.
				</span>
			</output>
		</div>
	);
}

/**
 * The editor's layout, drawn by the page while the editor frame loads: the
 * share page's video morphs into the player here, then the editor fades in
 * over it.
 */
export function EditorEntryFrame({ frame }: { frame: string | null }) {
	return (
		<div className="pointer-events-none absolute inset-0 flex flex-col gap-2 pb-2">
			<div className="h-[52px] shrink-0" />
			<div className="flex min-h-0 flex-1 gap-2 px-2">
				<div className="flex min-w-0 flex-1 flex-col rounded-xl bg-white/60 dark:bg-white/[0.04]">
					<div className="h-11 shrink-0" />
					<div className="flex min-h-0 flex-1 items-center justify-center p-4 [container-type:size]">
						<div
							className={clsx(
								"relative aspect-video w-[min(100cqw,100cqh*16/9)] overflow-hidden rounded-md",
								frame ? "bg-black" : "bg-black/[0.05] dark:bg-white/[0.05]",
							)}
							style={{ viewTransitionName: "cap-edit-video" }}
						>
							{frame && (
								<img src={frame} alt="" className="size-full object-contain" />
							)}
							<EntryLoadingStatus />
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
