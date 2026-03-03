"use client";

import { useEffect, useState } from "react";

interface Heading {
	level: number;
	text: string;
	slug: string;
}

interface DocsTableOfContentsProps {
	headings: Heading[];
}

export function DocsTableOfContents({ headings }: DocsTableOfContentsProps) {
	const [activeSlug, setActiveSlug] = useState<string>("");

	useEffect(() => {
		if (headings.length === 0) return;

		const slugs = headings.map((h) => h.slug);
		const elements = slugs
			.map((slug) => document.getElementById(slug))
			.filter(Boolean) as HTMLElement[];

		if (elements.length === 0) return;

		const observer = new IntersectionObserver(
			(entries) => {
				const visibleEntries = entries.filter((entry) => entry.isIntersecting);
				if (visibleEntries.length > 0) {
					const topEntry = visibleEntries.reduce((prev, curr) =>
						prev.boundingClientRect.top < curr.boundingClientRect.top
							? prev
							: curr,
					);
					setActiveSlug(topEntry.target.id);
				}
			},
			{
				rootMargin: "-80px 0px -60% 0px",
				threshold: 0,
			},
		);

		for (const el of elements) {
			observer.observe(el);
		}

		return () => observer.disconnect();
	}, [headings]);

	const filteredHeadings = headings.filter(
		(h) => h.level === 2 || h.level === 3,
	);

	if (filteredHeadings.length === 0) return null;

	return (
		<div className="hidden xl:block sticky top-[80px] w-[200px] shrink-0 max-h-[calc(100vh-100px)] overflow-y-auto">
			<h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-3">
				On this page
			</h4>
			<ul className="flex flex-col gap-1">
				{filteredHeadings.map((heading, index) => (
					<li key={`${heading.slug}-${index}`}>
						<a
							href={`#${heading.slug}`}
							className={`block text-[13px] py-1 transition-colors ${
								heading.level === 3 ? "pl-3" : ""
							} ${
								activeSlug === heading.slug
									? "text-blue-500 font-medium"
									: "text-gray-500 hover:text-gray-700"
							}`}
						>
							{heading.text}
						</a>
					</li>
				))}
			</ul>
		</div>
	);
}
