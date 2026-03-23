import { buildEnv } from "@cap/env";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CustomMDX } from "@/components/mdx";
import { extractHeadings, getDocBySlug } from "@/utils/docs";
import { DocsBreadcrumbs } from "../_components/DocsBreadcrumbs";
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

	const { title, summary: description, image } = doc.metadata;
	const ogImage = image ? `${buildEnv.NEXT_PUBLIC_WEB_URL}${image}` : undefined;

	return {
		title: `${title} - Cap Docs`,
		description: description || title,
		openGraph: {
			title: `${title} - Cap Docs`,
			description: description || title,
			type: "article",
			url: `${buildEnv.NEXT_PUBLIC_WEB_URL}/docs/${slug}`,
			...(ogImage && { images: [{ url: ogImage }] }),
		},
	};
}

export default async function DocPage(props: DocPageProps) {
	const params = await props.params;
	const slug = params.slug?.join("/") ?? "introduction";
	const doc = getDocBySlug(slug);

	if (!doc) {
		notFound();
	}

	const headings = extractHeadings(doc.content);

	return (
		<div className="flex">
			<div className="flex-1 min-w-0 max-w-3xl mx-auto px-6 sm:px-8 py-10">
				<DocsBreadcrumbs currentSlug={slug} />
				<article className="mt-4">
					<h1 className="text-3xl font-bold tracking-tight text-gray-900 mb-2">
						{doc.metadata.title}
					</h1>
					{doc.metadata.summary && (
						<p className="text-lg text-gray-500 mb-8">{doc.metadata.summary}</p>
					)}
					<div className="prose prose-gray max-w-none prose-headings:scroll-mt-20 prose-headings:font-semibold prose-a:text-blue-600 prose-code:before:content-none prose-code:after:content-none prose-code:bg-gray-100 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm [&_pre]:rounded-lg [&_pre]:p-4 [&_pre]:overflow-x-auto [&_pre]:text-[13px] [&_pre]:leading-relaxed [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[inherit] [&_iframe]:max-w-full [&_iframe]:w-full">
						<CustomMDX source={doc.content} />
					</div>
				</article>
				<DocsPrevNext currentSlug={slug} />
			</div>
			<div className="hidden xl:block w-[200px] shrink-0">
				<DocsTableOfContents headings={headings} />
			</div>
		</div>
	);
}
