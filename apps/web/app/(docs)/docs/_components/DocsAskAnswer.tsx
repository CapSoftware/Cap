"use client";

import { FileText } from "lucide-react";
import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface DocsAskAnswerProps {
	answer: string;
	onNavigate: () => void;
}

function extractDocLinks(answer: string) {
	const links: Array<{ href: string; title: string }> = [];
	const seen = new Set<string>();
	for (const match of answer.matchAll(/\[([^\]]+)\]\((\/docs\/[\w/-]+)\)/g)) {
		const title = match[1];
		const href = match[2];
		if (!title || !href || seen.has(href)) continue;
		seen.add(href);
		links.push({ href, title });
	}
	return links.slice(0, 4);
}

export default function DocsAskAnswer({
	answer,
	onNavigate,
}: DocsAskAnswerProps) {
	const sources = extractDocLinks(answer);

	return (
		<div>
			<div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
				<Markdown
					remarkPlugins={[remarkGfm]}
					components={{
						p: (props) => (
							<p className="my-2 text-sm leading-6 text-gray-11">
								{props.children}
							</p>
						),
						a: (props) => {
							const href = typeof props.href === "string" ? props.href : "";
							if (href.startsWith("/")) {
								return (
									<Link
										href={href}
										onClick={onNavigate}
										className="font-medium text-blue-11 underline-offset-[3px] hover:underline"
									>
										{props.children}
									</Link>
								);
							}
							return (
								<a
									href={href}
									target="_blank"
									rel="noopener noreferrer"
									className="font-medium text-blue-11 underline-offset-[3px] hover:underline"
								>
									{props.children}
								</a>
							);
						},
						strong: (props) => (
							<strong className="font-medium text-gray-12">
								{props.children}
							</strong>
						),
						pre: (props) => (
							<pre className="my-2.5 overflow-x-auto rounded-lg bg-[#0E1116] p-3 text-xs leading-relaxed text-[#C9CED6] [scrollbar-width:thin] [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit">
								{props.children}
							</pre>
						),
						code: (props) => (
							<code className="rounded border border-gray-4 bg-gray-2 px-1 py-0.5 text-[12px] text-gray-12">
								{props.children}
							</code>
						),
						ul: (props) => (
							<ul className="my-2 list-disc space-y-1 pl-5 text-sm leading-6 text-gray-11">
								{props.children}
							</ul>
						),
						ol: (props) => (
							<ol className="my-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-gray-11">
								{props.children}
							</ol>
						),
						li: (props) => (
							<li className="text-sm leading-6 text-gray-11 [&>p]:my-0.5">
								{props.children}
							</li>
						),
						h1: (props) => (
							<p className="mb-1.5 mt-3 text-sm font-medium text-gray-12">
								{props.children}
							</p>
						),
						h2: (props) => (
							<p className="mb-1.5 mt-3 text-sm font-medium text-gray-12">
								{props.children}
							</p>
						),
						h3: (props) => (
							<p className="mb-1.5 mt-3 text-sm font-medium text-gray-12">
								{props.children}
							</p>
						),
						h4: (props) => (
							<p className="mb-1.5 mt-3 text-sm font-medium text-gray-12">
								{props.children}
							</p>
						),
					}}
				>
					{answer}
				</Markdown>
			</div>
			{sources.length > 0 && (
				<div className="mt-3 flex flex-wrap items-center gap-1.5">
					<span className="mr-0.5 text-xs text-gray-9">Sources</span>
					{sources.map((source) => (
						<Link
							key={source.href}
							href={source.href}
							onClick={onNavigate}
							className="flex items-center gap-1 rounded-full border border-gray-4 bg-gray-2 px-2.5 py-1 text-xs text-gray-11 transition-colors hover:border-gray-5 hover:text-gray-12"
						>
							<FileText className="size-3 text-gray-9" />
							{source.title}
						</Link>
					))}
				</div>
			)}
		</div>
	);
}
