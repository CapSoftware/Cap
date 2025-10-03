import { recordScreenMacContent } from "../content/blog-content/record-screen-mac-system-audio";
import { recordScreenWindowsContent } from "../content/blog-content/windows-11-record-screen-system-audio-no-stereo-mix";

export const INTERACTIVE_BLOG_REGISTRY = {
	[recordScreenMacContent.slug]: recordScreenMacContent,
	[recordScreenWindowsContent.slug]: recordScreenWindowsContent,
} as const;

export type InteractiveBlogSlug = keyof typeof INTERACTIVE_BLOG_REGISTRY;

export function getInteractiveBlogContent(slug: string) {
	const content = INTERACTIVE_BLOG_REGISTRY[slug as InteractiveBlogSlug];
	if (!content) {
		throw new Error(`No interactive blog content found for slug: ${slug}`);
	}
	return content;
}

export function isInteractiveBlogPost(
	slug: string | number,
): slug is InteractiveBlogSlug {
	return typeof slug === "string" && slug in INTERACTIVE_BLOG_REGISTRY;
}

export function getAllInteractiveBlogPosts() {
	return Object.values(INTERACTIVE_BLOG_REGISTRY);
}
