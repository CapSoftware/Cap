import { seoPages } from "@/lib/seo-pages";
import { MetadataRoute } from "next";
import { headers } from "next/headers";

export const revalidate = 0;

export default function robots(): MetadataRoute.Robots {
  const seoPageSlugs = Object.keys(seoPages);
  const headersList = headers();
  
  const referrer = headersList.get("x-referrer") || "";
  const userAgentHeader = headersList.get("x-user-agent") || "";
  
  let ua;
  let userAgentString = "";
  
  try {
    ua = JSON.parse(userAgentHeader);
    userAgentString = ua.ua || "";
  } catch (error) {
    console.error('Error parsing user agent JSON:', error);
    userAgentString = userAgentHeader;
  }
  
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
    "twitterbot"
  ];
  
  const isAllowedReferrer = allowedReferrers.some(domain => 
    referrer.includes(domain)
  );
  
  const userAgentLower = userAgentString.toLowerCase();
  const isAllowedBot = allowedBots.some(bot => 
    userAgentLower.includes(bot.toLowerCase())
  );
  
  const shouldAllowCrawling = isAllowedReferrer || isAllowedBot;
  
  const isTwitterBot = userAgentLower.includes('twitterbot');
  
  const disallowPaths = [
    "/dashboard",
    "/login",
    "/invite",
    "/onboarding",
    "/record",
    "/home",
  ];

  if (isTwitterBot) {
    return {
      rules: [
        {
          userAgent: "*",
          allow: [
            "/",
            "/blog/",
            ...seoPageSlugs.map((slug) => `/${slug}`),
            "/s/*",
          ],
          disallow: disallowPaths,
        },
      ],
      sitemap: "https://cap.so/sitemap.xml",
    };
  }

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