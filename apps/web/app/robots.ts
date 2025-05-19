import { seoPages } from "@/lib/seo-pages";
import { MetadataRoute } from "next";
import { headers } from "next/headers";

export const revalidate = 0;

export default function robots(): MetadataRoute.Robots {
  const seoPageSlugs = Object.keys(seoPages);
  const headersList = headers();
  
  const referrer = headersList.get("x-referrer") || "";
  const userAgent = headersList.get("x-user-agent") || "";
  
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
    "t.co"
  ];
  
  const allowedBots = [
    "Twitterbot"
  ];
  
  const isAllowedReferrer = allowedReferrers.some(domain => 
    referrer.includes(domain)
  );
  
  const isAllowedBot = allowedBots.some(bot => 
    userAgent.includes(bot)
  );
  
  const shouldAllowCrawling = isAllowedReferrer || isAllowedBot;
  
  const disallowPaths = [
    "/dashboard",
    "/login",
    "/invite",
    "/onboarding",
    "/record",
    "/home",
  ];

  if (!shouldAllowCrawling) {
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
          ...(shouldAllowCrawling ? ["/s/*"] : []),
        ],
        disallow: disallowPaths,
      },
    ],
    sitemap: "https://cap.so/sitemap.xml",
  };
}