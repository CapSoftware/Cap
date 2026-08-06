import { buildEnv } from "@cap/env";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CustomMDX } from "@/components/mdx";
import { ogImageUrl } from "@/lib/og/url";
import { extractHeadings, getDocBySlug } from "@/utils/docs";
import { CopyablePrompt } from "../_components/CopyablePrompt";
import { DocsAskCta } from "../_components/DocsAskCta";
import { DocsBreadcrumbs } from "../_components/DocsBreadcrumbs";
import { DocsCodeBlock } from "../_components/DocsCodeBlock";
import { DocsPrevNext } from "../_components/DocsPrevNext";
import { DocsTableOfContents } from "../_components/DocsTableOfContents";

interface DocPageProps {
	params: Promise<{ slug?: string[] }>;
}

export async function generateMetadata(
	props: DocPageProps,
): Promise<Metadata | undefined> {
	const params = await props.params;
	const slug = params.slug?.join("/") ?? "introduction";
	const doc = getDocBySlug(slug);
	if (!doc) return;

	const { title, summary, image } = doc.metadata;
	// "/docs" resolves to the Introduction doc, but "Introduction" makes a
	// meaningless share card — present the landing page as the docs home.
	const isDocsHome = slug === "introduction";
	const pageTitle = isDocsHome ? "Cap Documentation" : `${title} - Cap Docs`;
	const description = summary || title;
	const ogImage = image
		? `${buildEnv.NEXT_PUBLIC_WEB_URL}${image}`
		: ogImageUrl({
				title: isDocsHome ? "Cap Documentation" : title,
				tag: "Docs",
				description: isDocsHome
					? "Guides for recording, editing, sharing, and self-hosting Cap."
					: summary || undefined,
			});

	return {
		title: pageTitle,
		description,
		openGraph: {
			title: pageTitle,
			description,
			type: "article",
			url: `${buildEnv.NEXT_PUBLIC_WEB_URL}/docs/${slug}`,
			images: [{ url: ogImage, width: 1200, height: 630, alt: pageTitle }],
		},
		twitter: {
			card: "summary_large_image",
			title: pageTitle,
			description,
			images: [ogImage],
		},
	};
}

const proseClassName = [
	"prose prose-sm max-w-none",
	"prose-headings:scroll-mt-24 prose-headings:font-medium prose-headings:tracking-[-0.01em] prose-headings:text-gray-12",
	"prose-h2:mb-4 prose-h2:mt-12 prose-h2:text-xl prose-h2:leading-7",
	"prose-h3:mb-3 prose-h3:mt-8 prose-h3:text-[17px] prose-h3:leading-6",
	"prose-p:my-4 prose-p:text-[15px] prose-p:leading-[1.75] prose-p:text-gray-11",
	"prose-a:font-medium prose-a:text-blue-11 prose-a:no-underline prose-a:underline-offset-[3px] hover:prose-a:underline",
	"prose-strong:font-medium prose-strong:text-gray-12",
	"prose-ul:my-4 prose-ol:my-4 prose-li:my-1.5 prose-li:text-[15px] prose-li:leading-[1.75] prose-li:text-gray-11",
	"prose-blockquote:my-5 prose-blockquote:border-l-2 prose-blockquote:border-gray-6 prose-blockquote:pl-4 prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-gray-11",
	"prose-code:before:content-none prose-code:after:content-none",
	"[&_:not(pre)>code]:rounded-md [&_:not(pre)>code]:border [&_:not(pre)>code]:border-gray-4 [&_:not(pre)>code]:bg-gray-2 [&_:not(pre)>code]:px-[0.35em] [&_:not(pre)>code]:py-[0.12em] [&_:not(pre)>code]:text-[13px] [&_:not(pre)>code]:font-normal [&_:not(pre)>code]:text-gray-12",
	"prose-figure:my-6",
	"prose-hr:border-gray-3",
	"prose-table:my-6 prose-table:w-full",
	"prose-thead:border-b prose-thead:border-gray-4",
	"prose-th:px-3.5 prose-th:py-2 prose-th:text-left prose-th:text-[13px] prose-th:font-medium prose-th:text-gray-12",
	"prose-tr:border-b prose-tr:border-gray-3",
	"prose-td:px-3.5 prose-td:py-2.5 prose-td:align-top prose-td:text-sm prose-td:leading-6 prose-td:text-gray-11",
	"[&_th:first-child]:pl-0 [&_td:first-child]:pl-0",
	"prose-img:rounded-xl prose-img:border prose-img:border-gray-3",
	"[&_iframe]:w-full [&_iframe]:max-w-full [&_iframe]:rounded-xl",
].join(" ");

export default async function DocPage(props: DocPageProps) {
	const params = await props.params;
	const slug = params.slug?.join("/") ?? "introduction";
	const doc = getDocBySlug(slug);

	if (!doc) {
		notFound();
	}

	const headings = extractHeadings(doc.content);

	return (
		<div className="flex gap-10">
			<div className="mx-auto w-full min-w-0 max-w-3xl py-10 sm:px-6 lg:px-10">
				<DocsBreadcrumbs currentSlug={slug} pageTitle={doc.metadata.title} />
				<h1 className="text-[28px] font-medium leading-9 tracking-[-0.02em] text-gray-12 sm:text-[32px] sm:leading-10">
					{doc.metadata.title}
				</h1>
				{doc.metadata.summary && (
					<p className="mt-3 text-base leading-7 text-gray-10">
						{doc.metadata.summary}
					</p>
				)}
				<article className={`mt-8 ${proseClassName}`}>
					<CustomMDX
						source={doc.content}
						components={{ CopyablePrompt, pre: DocsCodeBlock }}
					/>
				</article>
				<DocsAskCta />
				<DocsPrevNext currentSlug={slug} />
			</div>
			<aside className="hidden w-[240px] shrink-0 xl:block">
				<DocsTableOfContents headings={headings} />
			</aside>
		</div>
	);
}
