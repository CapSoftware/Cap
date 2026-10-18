"use client";

export function DocsAskCta() {
	return (
		<div className="mt-12 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-xl border border-gray-4 bg-gray-2 px-4 py-3.5 text-sm text-gray-11">
			<span>Can't find what you need?</span>
			<button
				type="button"
				onClick={() =>
					window.dispatchEvent(
						new CustomEvent("open-docs-search", { detail: { mode: "ask" } }),
					)
				}
				className="font-medium text-blue-11 underline-offset-[3px] transition-colors hover:underline"
			>
				Ask the docs a question
			</button>
		</div>
	);
}
