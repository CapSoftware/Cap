import { buildEnv } from "@cap/env";
import { format, parseISO } from "date-fns";
import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { AuthorByline } from "@/components/blog/AuthorByline";
import { BlogTemplate } from "@/components/blog/BlogTemplate";
import { getPostComponents } from "@/components/blog/post-components";
import { ReadyToGetStarted } from "@/components/ReadyToGetStarted";
import { ogImageUrl } from "@/lib/og/url";
import { parseAuthors } from "@/utils/authors";
import { getBlogPosts } from "@/utils/blog";
import {
	getInteractiveBlogContent,
	isInteractiveBlogPost,
} from "@/utils/blog-registry";
import { calculateReadingTime } from "@/utils/readTime";
import { Share } from "../_components/Share";

interface PostProps {
	params: Promise<{
		slug: string;
	}>;
}

export async function generateMetadata(
	props: PostProps,
): Promise<Metadata | undefined> {
	const params = await props.params;
	const post = getBlogPosts().find((post) => post.slug === params.slug);
	if (!post) {
		return;
	}

	const {
		title,
		publishedAt: publishedTime,
		description,
		image,
		video,
	} = post.metadata as {
		title: string;
		publishedAt: string;
		description: string;
		image?: string;
		video?: string;
	};
	// Posts with real cover art keep it; everything else gets the branded
	// dynamic OG image.
	const ogImage =
		image && image !== "/og.png"
			? `${buildEnv.NEXT_PUBLIC_WEB_URL}${image}`
			: ogImageUrl({ title, tag: "Blog" });

	return {
		title,
		description,
		openGraph: {
			title,
			description,
			type: "article",
			publishedTime,
			url: `${buildEnv.NEXT_PUBLIC_WEB_URL}/blog/${post.slug}`,
			images: [
				{
					url: ogImage,
				},
			],
			// Discord, iMessage and Telegram play a silent looping MP4
			// from og:video; X and LinkedIn ignore it and use the image.
			...(video && {
				videos: [
					{
						url: `${buildEnv.NEXT_PUBLIC_WEB_URL}${video}`,
						type: "video/mp4",
						width: 1200,
						height: 630,
					},
				],
			}),
		},
		twitter: {
			card: "summary_large_image",
			title,
			description,
			images: [ogImage],
		},
	};
}

export default async function PostPage(props: PostProps) {
	const params = await props.params;
	const post = getBlogPosts().find((post) => post.slug === params.slug);

	if (!post) {
		notFound();
	}

	if (isInteractiveBlogPost(params.slug)) {
		const interactiveContent = getInteractiveBlogContent(params.slug);
		return <BlogTemplate content={interactiveContent} />;
	}

	const readingTime = calculateReadingTime(post.content);
	// `layout: feature` in the frontmatter swaps the cover image for a larger
	// title, the description as a subtitle and the authors up top.
	const feature = (post.metadata as { layout?: string }).layout === "feature";
	const publishedAt = parseISO(
		(post.metadata as { publishedAt?: string }).publishedAt ||
			new Date().toISOString(),
	);

	return (
		<>
			<article className="px-5 py-24 mx-auto md:py-40 prose">
				{post.metadata.image && !feature && (
					<div className="relative mb-6 h-[200px] sm:h-[280px] md:h-[345px] w-full rounded-lg overflow-hidden">
						<Image
							className="object-contain m-0 w-full sm:object-cover"
							src={post.metadata.image}
							alt={post.metadata.title}
							fill
							quality={100}
							priority
						/>
					</div>
				)}

				<div className="wrapper">
					{feature ? (
						<header className="not-prose">
							<h1 className="m-0 text-[40px] font-semibold leading-[1.06] tracking-[-0.03em] text-gray-12 sm:text-[56px]">
								{post.metadata.title}
							</h1>
							<div className="mt-4 max-w-[34rem] text-[19px] leading-[1.5] text-gray-10 sm:text-[21px]">
								{post.metadata.description}
							</div>
							<div className="mt-8 flex flex-wrap items-center justify-between gap-4">
								<div className="flex items-center gap-2.5">
									{parseAuthors(
										"author" in post.metadata ? post.metadata.author : "",
									).map((author) => (
										<span
											key={author.handle}
											className="flex items-center gap-2.5"
										>
											<Image
												src={author.image}
												alt=""
												width={28}
												height={28}
												className="m-0 size-7 rounded-full object-cover"
											/>
											<span className="text-[14px] font-medium text-gray-12">
												{author.name}
											</span>
										</span>
									))}
								</div>
								<span className="text-[14px] text-gray-10">
									{format(publishedAt, "MMM d, yyyy")} · {readingTime} min read
								</span>
							</div>
						</header>
					) : (
						<header>
							<h1 className="mb-2 font-semibold">{post.metadata.title}</h1>
							<p className="space-x-1 text-xs text-gray-12">
								<span>{format(publishedAt, "MMMM dd, yyyy")}</span>
								<span>—</span>
								<span>{readingTime} min read</span>
							</p>
						</header>
					)}
					<hr className={feature ? "my-10" : "my-6"} />
					<MDXRemote
						source={post.content}
						components={getPostComponents(post.slug)}
						options={
							feature
								? { mdxOptions: { remarkPlugins: [remarkGfm] } }
								: undefined
						}
					/>
					{!feature && "author" in post.metadata && post.metadata.author && (
						<AuthorByline authors={post.metadata.author} />
					)}
					<Share
						post={post}
						url={`${buildEnv.NEXT_PUBLIC_WEB_URL}/blog/${post.slug}`}
					/>
				</div>
			</article>
			<div className="mb-4 wrapper">
				<ReadyToGetStarted />
			</div>
		</>
	);
}
