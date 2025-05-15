import { seoPages } from "@/lib/seo-pages";
import { MetadataRoute } from "next";

export const revalidate = 0;

export default function robots(): MetadataRoute.Robots {
  const seoPageSlugs = Object.keys(seoPages);

  return {
    rules: [
      {
        userAgent: "*",
        allow: [
          "/",
          "/blog/",
          // Dynamically add all SEO pages
          ...seoPageSlugs.map((slug) => `/${slug}`),
        ],
        // Be more specific about what we're disallowing under /s/
        disallow: [
          "/dashboard",
          "/s/*",
          "/login",
          "/invite",
          "/onboarding",
          "/record",
          "/home",
        ],
      },
    ],
    sitemap: "https://cap.so/sitemap.xml",
  };
}
