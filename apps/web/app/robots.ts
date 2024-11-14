import { seoPages } from "@/lib/seo-pages";
import { MetadataRoute } from "next";

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function robots(): MetadataRoute.Robots {
  const seoPageSlugs = Object.keys(seoPages);
  
  return {
    rules: [
      {
        userAgent: '*',
        allow: [
          '/',
          '/updates/',
          // Dynamically add all SEO pages
          ...seoPageSlugs.map(slug => `/${slug}`),
        ],
        // Be more specific about what we're disallowing under /s/
        disallow: [
          '/dashboard',
          '/s/*', // This will match /s/ and anything under it
          '/login',
          '/invite',
          '/onboarding',
          '/record',
        ],
      },
    ],
    sitemap: 'https://cap.so/sitemap.xml',
  };
} 