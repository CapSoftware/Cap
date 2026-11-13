import { buildEnv } from "@cap/env";
import type { Metadata } from "next";
import { ogImageUrl } from "@/lib/og/url";
import { getBlogPosts } from "@/utils/blog";

/** Page metadata for a blog post, shared by every route that renders one. */
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
		alternates: { canonical: `https://cap.so/blog/${post.slug}` },
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
