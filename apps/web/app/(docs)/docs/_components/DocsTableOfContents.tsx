"use client";

import { AlignLeft } from "lucide-react";
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

		const elements = headings
			.map((h) => document.getElementById(h.slug))
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
				rootMargin: "-72px 0px -65% 0px",
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
		<nav
			aria-label="On this page"
			className="sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-y-auto py-10 [scrollbar-width:thin]"
		>
			<p className="mb-3 flex items-center gap-1.5 text-[13px] font-medium text-gray-12">
				<AlignLeft className="size-3.5 text-gray-9" />
				On this page
			</p>
			<ul className="flex flex-col">
				{filteredHeadings.map((heading, index) => (
					<li key={`${heading.slug}-${index}`}>
						<a
							href={`#${heading.slug}`}
							className={`block py-[5px] text-[13px] leading-5 transition-colors ${
								heading.level === 3 ? "pl-3.5" : ""
							} ${
								activeSlug === heading.slug
									? "font-medium text-blue-11"
									: "text-gray-10 hover:text-gray-12"
							}`}
						>
							{heading.text}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}
