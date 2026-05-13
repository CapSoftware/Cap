const SOCIAL_CRAWLER_USER_AGENT_PATTERNS = [
	"twitterbot",
	"facebookexternalhit",
	"facebot",
	"slackbot",
	"linkedinbot",
	"whatsapp",
	"discordbot",
	"telegrambot",
	"skypeuripreview",
	"microsoftpreview",
	"pinterestbot",
	"redditbot",
	"embedly",
] as const;

export const SOCIAL_REFERRER_DOMAINS = [
	"x.com",
	"twitter.com",
	"facebook.com",
	"fb.com",
	"slack.com",
	"notion.so",
	"linkedin.com",
	"reddit.com",
	"youtube.com",
	"quora.com",
	"t.co",
] as const;

export function isSocialCrawlerUserAgent(userAgent: string) {
	const normalizedUserAgent = userAgent.toLowerCase();
	return SOCIAL_CRAWLER_USER_AGENT_PATTERNS.some((pattern) =>
		normalizedUserAgent.includes(pattern),
	);
}
