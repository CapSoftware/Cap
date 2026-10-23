import clsx from "clsx";
import type { ReactNode } from "react";
import { htMono } from "../../pages/HomeTwo/fonts";
import { FadeIn } from "./shared";

const mono = htMono.className;

const SOLID = `<KSwitch.Control
  class="w-9 h-5 p-0.5 rounded-full bg-ed-ctl-active
         data-checked:bg-ed-accent"
>
  <KSwitch.Thumb
    class="size-4 rounded-full bg-white
           data-checked:translate-x-[calc(100%)]"
  />
</KSwitch.Control>`;

const GPUI = `div()
    .w(px(34.)).h(px(20.)).p(px(2.))
    .flex().rounded_full()
    .when(checked, |this| this.justify_end())
    .bg(if checked { on_fill } else { off_fill })
    .child(
        div().size(px(16.)).rounded_full().bg(white()),
    )`;

const TOKEN =
	/(?<string>"[^"]*")|(?<tag><\/?[A-Z][\w.]*|\/?>)|(?<keyword>\b(?:if|else)\b)|(?<number>\b\d+(?:\.\d*)?)|(?<call>\b[a-z_]\w*(?=\())|(?<attr>\bclass(?==))/g;

const COLORS: Record<string, string> = {
	string: "#0B7A3E",
	tag: "#8250DF",
	keyword: "#CF222E",
	number: "#0550AE",
	call: "#6639BA",
	attr: "#0550AE",
};

function highlight(code: string) {
	const parts: ReactNode[] = [];
	let cursor = 0;
	for (const match of code.matchAll(TOKEN)) {
		const index = match.index ?? 0;
		if (index > cursor) parts.push(code.slice(cursor, index));
		const kind = Object.entries(match.groups ?? {}).find(
			([, value]) => value !== undefined,
		)?.[0];
		parts.push(
			<span key={index} style={{ color: kind ? COLORS[kind] : undefined }}>
				{match[0]}
			</span>,
		);
		cursor = index + match[0].length;
	}
	parts.push(code.slice(cursor));
	return parts;
}

const FILES = [
	{ name: "Toggle.tsx", detail: "0.6.0, SolidJS and Tailwind", code: SOLID },
	{ name: "toggle.rs", detail: "0.6.1, GPUI", code: GPUI },
];

/** The same toggle switch in the old app and the new one, side by side. */
export function CodeCompare() {
	return (
		<FadeIn className="not-prose relative left-1/2 my-12 grid w-[min(calc(100vw-2.5rem),56rem)] -translate-x-1/2 gap-6 md:grid-cols-2 md:gap-4">
			{FILES.map((file) => (
				<div key={file.name} className="flex min-w-0 flex-col">
					<div className="mb-2.5 flex items-baseline gap-2 px-1 text-[13px]">
						<span className={clsx(mono, "text-gray-12")}>{file.name}</span>
						<span className="text-gray-10">{file.detail}</span>
					</div>
					<pre
						className={clsx(
							mono,
							"m-0 flex-1 overflow-x-auto rounded-[14px] bg-gray-2 px-5 py-4 text-[12.5px] leading-[1.75] text-gray-12 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)]",
						)}
					>
						<code>{highlight(file.code)}</code>
					</pre>
				</div>
			))}
		</FadeIn>
	);
}
