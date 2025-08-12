import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { seoPages } from "@/lib/seo-pages";

export const revalidate = 0;

export default function robots(): MetadataRoute.Robots {
	const seoPageSlugs = Object.keys(seoPages);
	const headersList = headers();
	const referrer = headersList.get("x-referrer") || "";

	const allowedReferrers = [
		"x.com",
		"facebook.com",
		"fb.com",
		"linkedin.com",
		"slack.com",
		"notion.so",
		"reddit.com",
		"youtube.com",
		"quora.com",
		"t.co",
	];

	const isAllowedReferrer = allowedReferrers.some((domain) =>
		referrer.includes(domain),
	);

	const disallowPaths = [
		"/dashboard",
		"/login",
		"/invite",
		"/onboarding",
		"/record",
		"/home",
	];

	if (!isAllowedReferrer) {
		disallowPaths.push("/s/*");
	}

	return {
		rules: [
			{
				userAgent: "*",
				allow: [
					"/",
					"/blog/",
					...seoPageSlugs.map((slug) => `/${slug}`),
					...(isAllowedReferrer ? ["/s/*"] : []),
				],
				disallow: disallowPaths,
			},
		],
		sitemap: "https://cap.so/sitemap.xml",
	};
}
