import { buildEnv } from "@cap/env";
import type { Metadata } from "next";
import { ogImageUrl } from "@/lib/og/url";
import { getBlogPosts } from "@/utils/blog";

export function blogPostMetadata(slug: string): Metadata | undefined {
	const post = getBlogPosts().find((post) => post.slug === slug);
	if (!post) {
		return;
	}

	const {
		title,
		publishedAt: publishedTime,
		description,
		image,
		video,
		seoTitle,
		seoDescription,
	} = post.metadata as {
		title: string;
		publishedAt: string;
		description: string;
		image?: string;
		video?: string;
		seoTitle?: string;
		seoDescription?: string;
	};
	const metaTitle = seoTitle ?? title;
	const metaDescription = seoDescription ?? description;
	// Posts with real cover art keep it; everything else gets the branded
	// dynamic OG image.
	const ogImage =
		image && image !== "/og.png"
			? `${buildEnv.NEXT_PUBLIC_WEB_URL}${image}`
			: ogImageUrl({ title, tag: "Blog" });

	return {
		title: metaTitle,
		description: metaDescription,
		alternates: { canonical: `https://cap.so/blog/${post.slug}` },
		openGraph: {
			title: metaTitle,
			description: metaDescription,
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
			title: metaTitle,
			description: metaDescription,
			images: [ogImage],
		},
	};
}
