import { seoPages } from "@/lib/seo-pages";
import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  // Get all SEO page slugs
  const seoPageSlugs = Object.keys(seoPages);
  
  return {
    rules: {
      userAgent: '*',
      allow: [
        '/',
        '/updates/',
        // Dynamically add all SEO pages
        ...seoPageSlugs.map(slug => `/${slug}`),
      ],
      disallow: [
        '/dashboard',
        '/s/',
        '/login',
        '/invite',
        '/onboarding',
        '/record',
      ],
    },
    sitemap: 'https://cap.so/sitemap.xml',
  };
} 