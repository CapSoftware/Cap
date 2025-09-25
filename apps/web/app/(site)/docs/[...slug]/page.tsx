import { buildEnv } from "@cap/env";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import type { DocMetadata } from "@/utils/blog";
import { getDocs } from "@/utils/blog";

type Doc = {
	metadata: DocMetadata;
	slug: string;
	content: string;
};

interface DocProps {
	params: Promise<{
		slug: string[];
	}>;
}

export async function generateMetadata(
	props: DocProps,
): Promise<Metadata | undefined> {
	const params = await props.params;
	if (!params?.slug) return;

	const fullSlug = params.slug.join("/");

	// If it's a category page
	if (params.slug.length === 1) {
		const category = params.slug[0];
		if (!category) return;

		const displayCategory = category
			.split("-")
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" ");

		return {
			title: `${displayCategory} Documentation - Cap`,
			description: `Documentation for ${displayCategory} in Cap`,
		};
	}

	// If it's a doc page
	const allDocs = getDocs() as Doc[];
	const doc = allDocs.find((doc) => doc.slug === fullSlug);
	if (!doc) return;

	const { title, summary, image } = doc.metadata;
	const ogImage = image ? `${buildEnv.NEXT_PUBLIC_WEB_URL}${image}` : undefined;
	const description = summary || title;

	return {
		title,
		description,
		openGraph: {
			title,
			description,
			type: "article",
			url: `${buildEnv.NEXT_PUBLIC_WEB_URL}/docs/${fullSlug}`,
			...(ogImage && {
				images: [{ url: ogImage }],
			}),
		},
		twitter: {
			card: "summary_large_image",
			title,
			description,
			...(ogImage && { images: [ogImage] }),
		},
	};
}

export default async function DocPage(props: DocProps) {
	const params = await props.params;
	if (!params?.slug) notFound();

	const fullSlug = params.slug.join("/");
	const allDocs = getDocs() as Doc[];

	// Handle category pages (e.g., /docs/s3-config)
	if (params.slug.length === 1) {
		const category = params.slug[0];
		if (!category) notFound();

		// Find docs that either:
		// 1. Have a slug that exactly matches the category, or
		// 2. Have a slug that starts with category/
		const categoryDocs = allDocs
			.filter(
				(doc) => doc.slug === category || doc.slug.startsWith(`${category}/`),
			)
			.sort((a, b) => {
				// Sort by depth (root level first)
				const aDepth = a.slug.split("/").length;
				const bDepth = b.slug.split("/").length;
				if (aDepth !== bDepth) return aDepth - bDepth;

				// Then by title
				return a.metadata.title.localeCompare(b.metadata.title);
			});

		if (categoryDocs.length === 0) {
			notFound();
		}

		// Format the category name for display
		const displayCategory = category
			.split("-")
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" ");

		// Find the root category doc if it exists
		const rootDoc = categoryDocs.find((doc) => doc.slug === category);

		return (
			<div className="px-5 py-32 mx-auto md:py-40 prose">
				<h1>{displayCategory} Documentation</h1>
				{/* Show root category content if it exists */}
				{rootDoc && (
					<div className="mb-8">
						<MDXRemote source={rootDoc.content} />
						<hr className="my-8" />
					</div>
				)}
				{/* Show subcategory docs */}
				{categoryDocs.length > (rootDoc ? 1 : 0) && (
					<>
						<h2 className="mt-0">Available Guides</h2>
						<div className="grid gap-4">
							{categoryDocs
								.filter((doc) => doc.slug !== category)
								.map((doc) => (
									<Link
										key={doc.slug}
										href={`/docs/${doc.slug}`}
										className="no-underline"
									>
										<div className="p-4 rounded-lg border transition-colors hover:border-blue-500">
											<h3 className="m-0">{doc.metadata.title}</h3>
											{doc.metadata.summary && (
												<p className="m-0 mt-2 text-gray-600 dark:text-gray-8">
													{doc.metadata.summary}
												</p>
											)}
											{doc.metadata.tags && (
												<div className="flex gap-2 mt-3">
													{doc.metadata.tags.split(", ").map((tag) => (
														<span
															key={tag}
															className="px-2 py-1 text-xs text-gray-600 rounded-full bg-gray-1 dark:bg-gray-800 dark:text-gray-8"
														>
															{tag}
														</span>
													))}
												</div>
											)}
										</div>
									</Link>
								))}
						</div>
					</>
				)}
			</div>
		);
	}

	// Handle individual doc pages
	const doc = allDocs.find((doc) => doc.slug === fullSlug);

	if (!doc) {
		notFound();
	}

	return (
		<article className="py-32 mx-auto md:py-40 sm:py-32 prose">
			{doc.metadata.image && (
				<div className="relative mb-12 h-[345px] w-full">
					<Image
						className="object-contain m-0 w-full rounded-lg sm:object-cover"
						src={doc.metadata.image}
						alt={doc.metadata.title}
						fill
						quality={100}
						priority
						sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
					/>
				</div>
			)}
			<div className="wrapper">
				<header>
					<h1 className="mb-2">{doc.metadata.title}</h1>
				</header>
				<hr className="my-6" />
				<MDXRemote source={doc.content} />
			</div>
		</article>
	);
}
